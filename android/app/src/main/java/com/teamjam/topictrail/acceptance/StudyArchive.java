package com.teamjam.topictrail.acceptance;

import java.io.*;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.util.*;
import java.util.regex.Pattern;
import javax.crypto.*;
import javax.crypto.spec.*;

/** V1: fixed header (version, salt, nonce prefix), then ordered, independently authenticated frames.
 * The authenticated empty final frame and required EOF protect the end of the stream.
 * Stage all plaintext in a private directory before allowing access to any original.
 */
final class StudyArchive {
  static final int MAX_FILES = 16384, MAX_DOCUMENT = 50 * 1024 * 1024, MAX_METADATA = 32 * 1024 * 1024;
  static final long MAX_TOTAL = 16L * 1024 * 1024 * 1024;
  private static final byte[] MAGIC = "TTSTUDY1".getBytes(StandardCharsets.US_ASCII);
  private static final int FRAME = 65536, ROUNDS = 600000, TAG = 16;
  private static final SecureRandom RANDOM = new SecureRandom();
  private static final Pattern FILE_PATH = Pattern.compile(
      "(?:documents|topictrail-cloud-v1/[a-z0-9]{20}/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})/[a-zA-Z0-9_-]{1,160}\\.(?:pdf|docx|pptx)");

  static final class Problem extends IOException {
    Problem(String message) { super(message); }
  }
  static final class Entry {
    final String path;
    final long bytes;
    final String sha256;
    Entry(String path, long bytes, String sha256) { this.path=path; this.bytes=bytes; this.sha256=sha256; }
  }
  static final class Opened {
    final String metadata;
    final Map<String,Entry> entries;
    Opened(String metadata, Map<String,Entry> entries) { this.metadata=metadata; this.entries=entries; }
  }

  static void checkPassphrase(String passphrase) throws Problem {
    if (passphrase.length() < 12 || passphrase.length() > 1024)
      throw new Problem("Use a passphrase of 12 to 1024 characters.");
  }
  static void checkPath(String path) throws Problem {
    if (path == null || !FILE_PATH.matcher(path).matches()) throw new Problem("An archive file path is invalid.");
  }
  static File owned(File root, String path) throws IOException {
    checkPath(path);
    File file = new File(root.getCanonicalFile(), path);
    if (!file.getCanonicalFile().equals(file)) throw new Problem("The file is outside the owned study directory.");
    return file;
  }

  // RFC 8018 PBKDF2-HMAC-SHA256 (one 256-bit block). The Mac fallback supports API 24/25,
  // where Android does not yet expose PBKDF2WithHmacSHA256 through SecretKeyFactory.
  static byte[] derive(String passphrase, byte[] salt) throws GeneralSecurityException {
    PBEKeySpec spec = new PBEKeySpec(passphrase.toCharArray(), salt, ROUNDS, 256);
    try {
      return SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).getEncoded();
    } catch (NoSuchAlgorithmException unavailable) {
      return deriveWithMac(passphrase, salt, ROUNDS);
    } finally { spec.clearPassword(); }
  }
  static byte[] deriveWithMac(String passphrase, byte[] salt, int rounds) throws GeneralSecurityException {
    Mac mac = Mac.getInstance("HmacSHA256");
    byte[] password = passphrase.getBytes(StandardCharsets.UTF_8);
    try { mac.init(new SecretKeySpec(password, "HmacSHA256")); } finally { Arrays.fill(password,(byte)0); }
    mac.update(salt);
    byte[] previous = mac.doFinal(new byte[]{0,0,0,1});
    byte[] result = previous.clone();
    byte[] next = new byte[mac.getMacLength()];
    for (int i=1; i<rounds; ++i) {
      mac.update(previous);
      mac.doFinal(next,0);
      for (int j=0; j<result.length; ++j) result[j] ^= next[j];
      byte[] swap = previous; previous = next; next = swap;
    }
    Arrays.fill(previous,(byte)0); Arrays.fill(next,(byte)0);
    return result;
  }

  private static final class Frames {
    final byte[] header, key;
    final Cipher cipher;
    int index;
    Frames(byte[] header, String passphrase) throws GeneralSecurityException {
      this.header=header;
      key=derive(passphrase, Arrays.copyOfRange(header,8,24));
      cipher=Cipher.getInstance("AES/GCM/NoPadding");
    }
    byte[] crypt(int mode, int size, byte[] bytes, int length) throws GeneralSecurityException, IOException {
      if (index >= (MAX_TOTAL + MAX_METADATA)/FRAME + MAX_FILES + 10) throw new Problem("The archive exceeds the size limit.");
      byte[] nonce = ByteBuffer.allocate(12).put(header,24,8).putInt(index++).array();
      cipher.init(mode,new SecretKeySpec(key,"AES"),new GCMParameterSpec(128,nonce));
      cipher.updateAAD(header);
      cipher.updateAAD(ByteBuffer.allocate(4).putInt(size).array());
      return cipher.doFinal(bytes,0,length);
    }
    void clear() { Arrays.fill(key,(byte)0); }
  }

  private static final class FrameWriter extends OutputStream {
    final DataOutputStream target;
    final Frames frames;
    final byte[] buffer = new byte[FRAME];
    int used;
    FrameWriter(OutputStream out, Frames frames) { target=new DataOutputStream(out); this.frames=frames; }
    void emit() throws IOException {
      try {
        byte[] encrypted = frames.crypt(Cipher.ENCRYPT_MODE,used,buffer,used);
        target.writeInt(used); target.write(encrypted); used=0;
      } catch (GeneralSecurityException e) { throw new IOException("Archive encryption failed.",e); }
    }
    @Override public void write(int b) throws IOException {
      buffer[used++]=(byte)b; if (used == FRAME) emit();
    }
    @Override public void write(byte[] data, int offset, int length) throws IOException {
      while (length > 0) {
        int take = Math.min(FRAME-used,length);
        System.arraycopy(data,offset,buffer,used,take); used+=take; offset+=take; length-=take;
        if (used == FRAME) emit();
      }
    }
    void finish() throws IOException {
      if (used > 0) emit();
      emit(); target.flush();
    }
  }
  private static final class FrameReader extends InputStream {
    final DataInputStream source;
    final Frames frames;
    byte[] plain = new byte[0]; int at;
    boolean finished;
    FrameReader(DataInputStream source, Frames frames) { this.source=source; this.frames=frames; }
    boolean ready() throws IOException {
      if (at < plain.length) return true;
      if (finished) return false;
      int size = source.readInt();
      if (size < 0 || size > FRAME) throw new Problem("The archive is incomplete or damaged.");
      byte[] enc = new byte[size + TAG]; source.readFully(enc);
      try { plain = frames.crypt(Cipher.DECRYPT_MODE,size,enc,enc.length); }
      catch (GeneralSecurityException e) { throw new Problem("The passphrase is incorrect or the archive is damaged."); }
      at=0;
      if (size == 0) {
        if (source.read() != -1) throw new Problem("The archive contains unexpected data.");
        finished=true;
      }
      return !finished;
    }
    @Override public int read() throws IOException { return ready() ? plain[at++] & 255 : -1; }
    @Override public int read(byte[] b,int off,int len) throws IOException {
      if (len == 0) return 0;
      if (!ready()) return -1;
      int take=Math.min(len,plain.length-at); System.arraycopy(plain,at,b,off,take); at+=take; return take;
    }
  }

  private static long boundedTotal(long total, long bytes) throws Problem {
    if (bytes < 1 || bytes > MAX_DOCUMENT || total + bytes > MAX_TOTAL)
      throw new Problem("The archive exceeds the supported study file size.");
    return total + bytes;
  }
  private static String hex(byte[] bytes) {
    char[] chars = new char[bytes.length*2];
    String digits = "0123456789abcdef";
    for (int i=0;i<bytes.length;i++) { chars[2*i]=digits.charAt((bytes[i]&255)>>>4); chars[2*i+1]=digits.charAt(bytes[i]&15); }
    return new String(chars);
  }
  private static byte[] copyExact(InputStream in, OutputStream out, long length) throws IOException, GeneralSecurityException {
    MessageDigest digest=MessageDigest.getInstance("SHA-256");
    byte[] buf=new byte[FRAME];
    while (length > 0) {
      int n=in.read(buf,0,(int)Math.min(length,buf.length));
      if (n < 1) throw new EOFException("Incomplete original file.");
      if (out != null) out.write(buf,0,n);
      digest.update(buf,0,n); length-=n;
    }
    return digest.digest();
  }
  static boolean matches(File file, Entry expected) throws IOException, GeneralSecurityException {
    if (!file.isFile() || file.length()!=expected.bytes) return false;
    try (InputStream in = new BufferedInputStream(new FileInputStream(file))) {
      return expected.sha256.equals(hex(copyExact(in,null,expected.bytes))) && in.read()==-1;
    }
  }

  static void write(OutputStream dest, File root, String passphrase, String metadata, List<String> paths, Map<String,Entry> expected)
      throws IOException, GeneralSecurityException {
    checkPassphrase(passphrase);
    byte[] json=metadata.getBytes(StandardCharsets.UTF_8);
    if (json.length==0 || json.length>MAX_METADATA || paths.size()>MAX_FILES || new HashSet<>(paths).size()!=paths.size()
        || !new HashSet<>(paths).containsAll(expected.keySet())) throw new Problem("The study inventory is invalid or too large.");
    byte[] header=new byte[32]; RANDOM.nextBytes(header); System.arraycopy(MAGIC,0,header,0,8);
    Frames frames=new Frames(header,passphrase);
    FrameWriter payload=new FrameWriter(dest,frames);
    try {
      dest.write(header); DataOutputStream out=new DataOutputStream(payload);
      out.writeInt(json.length); out.write(json); out.writeInt(paths.size());
      long total=0;
      for (String path:paths) {
        File file=owned(root,path);
        if (!file.isFile()) throw new Problem("An original is missing. Refresh the transfer inventory.");
        long size=file.length(); total=boundedTotal(total,size);
        out.writeUTF(path); out.writeLong(size);
        byte[] hash;
        try (InputStream in=new BufferedInputStream(new FileInputStream(file))) {
          hash=copyExact(in,out,size);
          if (in.read()!=-1) throw new Problem("An original changed during export. Try again.");
        }
        Entry check=expected.get(path);
        if (check!=null && ((check.bytes>=0 && check.bytes!=size) || (check.sha256!=null && !check.sha256.equals(hex(hash)))))
          throw new Problem("An original differs from the captured inventory. Try again.");
        out.write(hash);
      }
      payload.finish();
    } finally { frames.clear(); Arrays.fill(payload.buffer,(byte)0); }
  }

  static Opened read(InputStream src, File staging, String passphrase) throws IOException, GeneralSecurityException {
    checkPassphrase(passphrase);
    DataInputStream source=new DataInputStream(new BufferedInputStream(src));
    byte[] header=new byte[32]; source.readFully(header);
    if (!Arrays.equals(MAGIC,Arrays.copyOf(header,8))) throw new Problem("Choose a version 1 TopicTrail study archive.");
    Frames frames=new Frames(header,passphrase);
    try {
      DataInputStream in=new DataInputStream(new FrameReader(source,frames));
      int jsonLength=in.readInt();
      if (jsonLength<=0 || jsonLength>MAX_METADATA) throw new Problem("Invalid archive metadata size.");
      byte[] json=new byte[jsonLength]; in.readFully(json);
      String metadata=StandardCharsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(json)).toString();
      int count=in.readInt();
      if (count<0 || count>MAX_FILES) throw new Problem("Invalid archive file count.");
      Map<String,Entry> entries=new LinkedHashMap<>(); long total=0;
      for (int i=0;i<count;i++) {
        String path=in.readUTF(); checkPath(path);
        if (entries.containsKey(path)) throw new Problem("Duplicate original in archive.");
        long size=in.readLong(); total=boundedTotal(total,size);
        File staged=owned(staging,path); File parent=staged.getParentFile();
        if ((!parent.mkdirs() && !parent.isDirectory()) || !staged.createNewFile()) throw new IOException("Cannot stage original.");
        byte[] hash;
        try (FileOutputStream out=new FileOutputStream(staged)) { hash=copyExact(in,out,size); out.getFD().sync(); }
        byte[] recorded=new byte[32]; in.readFully(recorded);
        if (!MessageDigest.isEqual(recorded,hash)) throw new Problem("An original failed its integrity check.");
        entries.put(path,new Entry(path,size,hex(hash)));
      }
      if (in.read()!=-1) throw new Problem("Unexpected archive entries.");
      return new Opened(metadata,entries);
    } finally { frames.clear(); }
  }
  private StudyArchive() {}
}

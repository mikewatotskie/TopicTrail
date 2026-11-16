package com.teamjam.topictrail.acceptance;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/** Runs the actual platform-independent APK archive codec against synthetic originals. */
public class StudyArchiveCheck {
  static final String PASS = "four words é漢🙂 123";
  static final String PATH = "documents/guest-doc-1.pdf";
  static final String META = "{\"scope\":\"guest\",\"note\":\"test-only green margin annotation\"}";
  static int checks;
  interface Action { void apply() throws Exception; }
  static void require(boolean ok) { if (!ok) throw new AssertionError("check failed"); checks++; }
  static void refused(Action operation) throws Exception {
    try { operation.apply(); } catch (IOException | GeneralSecurityException expected) { checks++; return; }
    throw new AssertionError("operation unexpectedly succeeded");
  }
  static byte[] archive(File source, String pass, List<String> paths, Map<String, StudyArchive.Entry> expected) throws Exception {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    StudyArchive.write(out,source,pass,META,paths,expected);
    return out.toByteArray();
  }
  public static void main(String[] args) throws Exception {
    Path test = Paths.get(args[0]), source=Files.createDirectory(test.resolve("source"));
    Path original=source.resolve(PATH);
    Files.createDirectories(original.getParent());
    byte[] bytes = new byte[3*65536 + 111]; new Random(42).nextBytes(bytes);
    Files.write(original,bytes);
    String uid="11111111-2222-3333-4444-555555555555";
    String cloud="topictrail-cloud-v1/abcdefghijklmnopqrst/"+uid+"/study-"+uid+"-1.pptx";
    Files.createDirectories(source.resolve(cloud).getParent());
    Files.write(source.resolve(cloud),"%synthetic-pptx".getBytes(StandardCharsets.US_ASCII));
    byte[] salt="fixed-test-salt".getBytes(StandardCharsets.UTF_8);
    require(Arrays.equals(StudyArchive.deriveWithMac(PASS,salt,4096),
        SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(new PBEKeySpec(PASS.toCharArray(),salt,4096,256)).getEncoded()));
    List<String> paths=Arrays.asList(PATH,cloud);
    byte[] archive=archive(source.toFile(), PASS,paths,Collections.emptyMap());
    require(!new String(archive,StandardCharsets.ISO_8859_1).contains("green margin annotation"));
    require(!new String(archive,StandardCharsets.ISO_8859_1).contains(PATH));
    require(!Arrays.equals(archive,archive(source.toFile(),PASS,paths,Collections.emptyMap())));
    File stage=Files.createDirectory(test.resolve("correct")).toFile();
    StudyArchive.Opened opened=StudyArchive.read(new ByteArrayInputStream(archive),stage,PASS);
    require(opened.metadata.equals(META) && opened.entries.size()==2);
    require(StudyArchive.matches(new File(stage,PATH),opened.entries.get(PATH)));
    require(Arrays.equals(bytes,Files.readAllBytes(new File(stage,PATH).toPath())));
    require(StudyArchive.matches(new File(stage,cloud),opened.entries.get(cloud)));
    File destination=Files.createDirectory(test.resolve("empty-destination")).toFile();
    byte[] truncated=Arrays.copyOf(archive,archive.length-17);
    byte[] changed=archive.clone(); changed[changed.length/2]^=1;
    byte[] tail=Arrays.copyOf(archive, archive.length+1);
    byte[] header=archive.clone(); header[8]^=1;
    for (byte[] broken:new byte[][]{truncated,changed,tail,header}) {
      Path privateStage=Files.createTempDirectory(test,"invalid-");
      refused(()->StudyArchive.read(new ByteArrayInputStream(broken),privateStage.toFile(),PASS));
      require(destination.list().length==0);
    }
    refused(()->StudyArchive.read(new ByteArrayInputStream(archive),test.resolve("wrong-pass").toFile(),"wrong passphrase"));
    refused(()->archive(source.toFile(),PASS,Arrays.asList(PATH,PATH),Collections.emptyMap()));
    refused(()->archive(source.toFile(),PASS,Collections.singletonList("documents/missing.pdf"),Collections.emptyMap()));
    refused(()->archive(source.toFile(),PASS,paths,Collections.singletonMap(PATH,new StudyArchive.Entry(PATH,1,"bad"))));
    for (String invalid:Arrays.asList("../db.sqlite","documents/../secret.pdf","documents/sub/x.pdf","SecureStore","documents/a%2fb.pdf","documents/a.pdf?")) {
      refused(()->StudyArchive.owned(source.toFile(),invalid));
    }
    Files.write(new File(stage,PATH).toPath(),new byte[]{1,2});
    require(!StudyArchive.matches(new File(stage,PATH),opened.entries.get(PATH)));
    require(Arrays.equals(bytes,Files.readAllBytes(original)));
    System.out.println("Passed " + checks + " checks on archive integrity, native KDF compatibility, ownership and source preservation.");
  }
}

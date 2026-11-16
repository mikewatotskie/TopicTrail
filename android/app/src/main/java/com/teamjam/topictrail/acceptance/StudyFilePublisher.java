package com.teamjam.topictrail.acceptance;

import android.system.OsConstants;
import android.system.Os;
import android.system.ErrnoException;
import java.io.*;
import java.security.GeneralSecurityException;

final class StudyFilePublisher {
  static { System.loadLibrary("topictrail_transfer"); }
  private static native int renameNew(String staged, String destination);

  static void syncDirectory(File directory) throws IOException {
    FileDescriptor fd = null;
    try {
      fd = Os.open(directory.getAbsolutePath(), OsConstants.O_RDONLY, 0);
      Os.fsync(fd);
    } catch (ErrnoException failure) { throw new IOException(failure); }
    finally {
      if (fd != null) try { Os.close(fd); } catch (ErrnoException failure) { throw new IOException(failure); }
    }
  }

  static void commitStaged(File staged, File destination, StudyArchive.Entry entry, boolean allowIdentical) throws IOException, GeneralSecurityException {
    if (!StudyArchive.matches(staged, entry)) throw new StudyArchive.Problem("The staged original failed its integrity check.");
    try (RandomAccessFile data = new RandomAccessFile(staged, "rw")) { data.getFD().sync(); }
    int error = renameNew(staged.getAbsolutePath(), destination.getAbsolutePath());
    if (error == OsConstants.EEXIST && !(allowIdentical && StudyArchive.matches(destination, entry)))
      throw new StudyArchive.Problem("An existing original has different contents or the name is in use. Both copies have been preserved.");
    if (error == OsConstants.ENOSYS || error == OsConstants.EOPNOTSUPP || error == OsConstants.EINVAL)
      throw new StudyArchive.Problem("This device cannot safely install the original. Keep the old app and the archive, and restore on another device.");
    if (error != 0 && error != OsConstants.EEXIST)
      throw new StudyArchive.Problem("The device could not save the complete original (error " + error + "). Keep the old app and retry.");
  }

  static void publish(File source, File destination, StudyArchive.Entry entry) throws IOException, GeneralSecurityException {
    File directory = destination.getParentFile();
    if (directory == null || (!directory.mkdirs() && !directory.isDirectory()))
      throw new StudyArchive.Problem("The private document directory could not be opened.");
    // Cache and files may have different Android project quotas. Publish from the destination
    // directory itself. This deterministic private staging name can be safely retried after death.
    File temporary = new File(directory, ".tt-restore-" + entry.sha256 + ".part");
    try {
      try (InputStream in = new BufferedInputStream(new FileInputStream(source));
           FileOutputStream out = new FileOutputStream(temporary)) {
        byte[] buffer = new byte[64 * 1024];
        int read;
        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
      }
      commitStaged(temporary, destination, entry, true);
    } finally { temporary.delete(); }
  }
}

#include <jni.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/fs.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Java passes only canonical, validated paths in the application's private storage.
 * renameat2 puts the whole validated file in place and cannot replace a competing file. */
JNIEXPORT jint JNICALL
Java_com_teamjam_topictrail_acceptance_StudyFilePublisher_renameNew(
    JNIEnv *env, jclass type, jstring staged, jstring destination) {
    (void)type;
    const char *from = (*env)->GetStringUTFChars(env, staged, NULL);
    if (from == NULL) return ENOMEM;
    const char *to = (*env)->GetStringUTFChars(env, destination, NULL);
    int result = ENOMEM;
    if (to != NULL) {
        int status;
        do {
            status = (int)syscall(__NR_renameat2, AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE);
        } while (status < 0 && errno == EINTR);
        result = status == 0 ? 0 : errno;
        (*env)->ReleaseStringUTFChars(env, destination, to);
    }
    (*env)->ReleaseStringUTFChars(env, staged, from);
    return result;
}

package com.teamjam.topictrail.acceptance

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.*
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors

class StudyTransferPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    when (name) {
      StudyTransferModule.NAME -> StudyTransferModule(reactContext)
      StudyMetadataModule.NAME -> StudyMetadataModule(reactContext)
      StudyOcrModule.NAME -> StudyOcrModule(reactContext)
      else -> null
    }

  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    val name = StudyTransferModule.NAME
    val store = StudyMetadataModule.NAME
    mapOf(name to ReactModuleInfo(name, StudyTransferModule::class.java.name, false, false, false, false),
      store to ReactModuleInfo(store, StudyMetadataModule::class.java.name, false, false, false, false),
      StudyOcrModule.NAME to ReactModuleInfo(StudyOcrModule.NAME, StudyOcrModule::class.java.name, false, false, false, false))
  }
}

private class PendingPicker(val code: Int, val promise: Promise, val action: (Uri) -> Any?)
private class Staged(val ticket: String, val directory: File, val opened: StudyArchive.Opened)

class StudyTransferModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  companion object {
    const val NAME = "TopicTrailTransfer"
    private const val CREATE = 0x5451
    private const val OPEN = 0x5452
  }

  private val role = when (context.packageName) {
    "com.teamjam.topictrail.acceptance" -> "legacy"
    "com.teamjam.topictrail" -> "production"
    else -> "unavailable"
  }
  private val worker = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private val temp = File(context.cacheDir, "topictrail-study-transfer-v1")
  private var staged: Staged? = null // worker thread only
  private var picker: PendingPicker? = null // UI thread only
  private val listener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      val pending = picker ?: return
      if (requestCode != pending.code) return
      picker = null
      if (resultCode != Activity.RESULT_OK || data?.data == null) {
        pending.promise.reject("TRANSFER_CANCELLED", "Transfer cancelled.")
        return
      }
      val uri = data.data!!
      if (uri.scheme != "content") {
        pending.promise.reject("TRANSFER_FAILED", "Choose a file using the Android document picker.")
        return
      }
      run(pending.promise) { pending.action(uri) }
    }
  }

  init {
    context.addActivityEventListener(listener)
    // The only files under this cache are this module's temporary ciphertext or staged originals.
    worker.execute { clearTemp() }
  }
  override fun getName() = NAME
  override fun getConstants(): Map<String, Any> {
    // Metro debug clients can serve assets outside the APK. Advertise streaming only for packaged viewers.
    val hasReaderAssets = listOf("assets_reader_viewer", "assets_reader_officeviewer").all { name ->
      context.resources.getIdentifier(name, "raw", context.packageName) != 0
    }
    return mapOf("role" to role, "packageName" to context.packageName, "readerStreamVersion" to if (hasReaderAssets) 1 else 0)
  }

  private fun clearTemp() {
    staged = null
    temp.deleteRecursively()
  }
  private fun run(promise: Promise, action: () -> Any?) {
    worker.execute {
      try { promise.resolve(action()) }
      catch (error: Exception) {
        // Provider exceptions can contain filenames, URIs or paths. Keep the bridge message generic.
        val message = when (error) {
          is StudyArchive.Problem -> error.message
          else -> "Transfer could not finish. Check the archive and available storage, then try again."
        }
        promise.reject("TRANSFER_FAILED", message)
      }
    }
  }

  private fun pick(intent: Intent, code: Int, promise: Promise, action: (Uri) -> Any?) {
    main.post {
      val activity = context.currentActivity
      if (picker != null || activity == null) {
        promise.reject("TRANSFER_BUSY", "Finish the open picker and return to TopicTrail.")
      } else {
        picker = PendingPicker(code, promise, action)
        try { activity.startActivityForResult(intent, code) }
        catch (_: Exception) {
          picker = null
          promise.reject("TRANSFER_FAILED", "The Android document picker could not open.")
        }
      }
    }
  }
  private fun paths(values: ReadableArray): List<String> {
    if (values.size() > StudyArchive.MAX_FILES) throw StudyArchive.Problem("Too many originals.")
    val paths = (0 until values.size()).map {
      val path = values.getString(it) ?: throw StudyArchive.Problem("Invalid original path.")
      StudyArchive.checkPath(path)
      path
    }
    if (paths.distinct().size != paths.size) throw StudyArchive.Problem("Duplicate original path.")
    return paths
  }

  @ReactMethod
  fun exportArchive(password: String, metadata: String, files: ReadableArray, expected: ReadableMap, promise: Promise) {
    if (role == "unavailable") {
      promise.reject("TRANSFER_FAILED", "This build cannot export study data.")
      return
    }
    val intent = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = "application/octet-stream"
      putExtra(Intent.EXTRA_TITLE, "TopicTrail-" + System.currentTimeMillis() + ".ttstudy")
    }
    pick(intent, CREATE, promise) { uri ->
      val paths = paths(files)
      val checks = mutableMapOf<String, StudyArchive.Entry>()
      val keys = expected.keySetIterator()
      while (keys.hasNextKey()) {
        val path = keys.nextKey()
        val item = expected.getMap(path) ?: throw StudyArchive.Problem("Invalid original inventory.")
        val bytes = if (item.hasKey("bytes")) item.getDouble("bytes").toLong() else -1L
        val hash = if (item.hasKey("sha256")) item.getString("sha256") else null
        checks[path] = StudyArchive.Entry(path, bytes, hash)
      }
      if (!temp.mkdirs() && !temp.isDirectory) throw IOException()
      val ciphertext = File.createTempFile("export-", ".tmp", temp)
      try {
        ciphertext.outputStream().buffered().use { StudyArchive.write(it, context.filesDir, password, metadata, paths, checks) }
        // Complete the local snapshot before handing a single byte to the external SAF provider.
        (context.contentResolver.openOutputStream(uri, "wt") ?: throw IOException()).use { output ->
          ciphertext.inputStream().buffered().use { it.copyTo(output) }
          output.flush()
        }
      } finally { ciphertext.delete() }
      null
    }
  }

  @ReactMethod
  fun openArchive(password: String, promise: Promise) {
    if (role != "production") {
      promise.reject("TRANSFER_FAILED", "Only the privately signed app imports study archives.")
      return
    }
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      // Android providers use different MIME types for files saved with our .ttstudy extension.
      type = "*/*"
    }
    pick(intent, OPEN, promise) { uri ->
      clearTemp()
      val id = UUID.randomUUID().toString()
      val dir = File(temp,id)
      if (!dir.mkdirs()) throw IOException()
      try {
        val opened = (context.contentResolver.openInputStream(uri) ?: throw IOException()).use {
          StudyArchive.read(it, dir, password)
        }
        staged = Staged(id, dir, opened)
        Arguments.createMap().apply {
          putString("ticket", id)
          putString("metadataJson", opened.metadata)
          putArray("files", Arguments.createArray().apply {
            for (entry in opened.entries.values) pushMap(Arguments.createMap().apply {
              putString("path", entry.path)
              putDouble("bytes", entry.bytes.toDouble())
              putString("sha256", entry.sha256)
            })
          })
        }
      } catch (e: Exception) { clearTemp(); throw e }
    }
  }

  private fun selected(ticket: String): Staged = staged?.takeIf { it.ticket == ticket }
    ?: throw StudyArchive.Problem("Reopen the study archive to continue.")

  private fun checkOriginals(stage: Staged, paths: List<String>) {
    for (path in paths) {
      val entry = stage.opened.entries[path] ?: throw StudyArchive.Problem("Original missing from the archive.")
      val destination = StudyArchive.owned(context.filesDir, path)
      if (destination.exists() && !StudyArchive.matches(destination,entry)) {
        throw StudyArchive.Problem("An existing original has different contents. Both copies have been preserved.")
      }
      if (!StudyArchive.matches(StudyArchive.owned(stage.directory,path),entry))
        throw StudyArchive.Problem("Staged original is missing or damaged. Reopen the archive.")
    }
  }

  @ReactMethod
  fun preflightFiles(ticket: String, files: ReadableArray, promise: Promise) {
    run(promise) { checkOriginals(selected(ticket), paths(files)); null }
  }

  @ReactMethod
  fun promoteFiles(ticket: String, files: ReadableArray, promise: Promise) {
    run(promise) {
      val stage = selected(ticket)
      val selectedPaths = paths(files)
      checkOriginals(stage, selectedPaths)
      for (path in selectedPaths) {
        val destination = StudyArchive.owned(context.filesDir,path)
        val source = StudyArchive.owned(stage.directory,path)
        val entry = stage.opened.entries.getValue(path)
        if (!StudyArchive.matches(destination,entry)) StudyFilePublisher.publish(source, destination, entry)
        syncParents(destination)
      }
      null
    }
  }

  private fun syncParents(destination: File) {
    val owned = context.filesDir.canonicalFile
    var directory = destination.parentFile
    while (directory != null) {
      StudyFilePublisher.syncDirectory(directory)
      if (directory == owned) return
      directory = directory.parentFile
    }
    throw IOException()
  }

  @ReactMethod
  fun publishOriginal(stagedUri: String, relativeDestination: String, bytes: Double, sha256: String, allowIdentical: Boolean, promise: Promise) {
    run(promise) {
      if (role != "production") throw StudyArchive.Problem("Only the privately signed app can publish an original.")
      if (bytes != bytes.toLong().toDouble() || bytes < 0 || bytes > StudyArchive.MAX_DOCUMENT || !Regex("[a-f0-9]{64}").matches(sha256))
        throw StudyArchive.Problem("The original inventory is invalid.")
      val destination = StudyArchive.owned(context.filesDir,relativeDestination)
      val uri = Uri.parse(stagedUri)
      if (uri.scheme != "file" || !uri.authority.isNullOrEmpty()) throw StudyArchive.Problem("The staged file must be private.")
      // Expo may spell the same sandbox as /data/data or /data/user/0. Its name identifies a
      // temp file in our independently derived destination directory. Never open the supplied path.
      val name = uri.lastPathSegment
      if (name == null || !Regex("incoming-[a-zA-Z0-9_-]{1,160}").matches(name))
        throw StudyArchive.Problem("The staged file is outside its owned directory.")
      val file = File(destination.parentFile ?: throw IOException(),name)
      if (file.canonicalFile != file) throw StudyArchive.Problem("The staged file is outside its owned directory.")
      val entry = StudyArchive.Entry(relativeDestination,bytes.toLong(),sha256)
      StudyFilePublisher.commitStaged(file,destination,entry,allowIdentical)
      syncParents(destination)
      null
    }
  }

  @ReactMethod
  fun discard(ticket: String, promise: Promise) {
    run(promise) {
      if (staged?.ticket == ticket) clearTemp()
      null
    }
  }

  override fun invalidate() {
    context.removeActivityEventListener(listener)
    main.post {
      picker?.promise?.reject("TRANSFER_CANCELLED", "Transfer cancelled.")
      picker = null
    }
    worker.execute { clearTemp() }
    worker.shutdown()
    super.invalidate()
  }
}


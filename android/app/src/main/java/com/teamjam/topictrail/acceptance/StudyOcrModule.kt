package com.teamjam.topictrail.acceptance

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import androidx.core.content.FileProvider
import com.facebook.react.bridge.*
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

internal data class CappedOcrTranscript(val text: String, val truncated: Boolean)

/** Match the JS UTF-16 limit without leaving half a surrogate pair at the boundary. */
internal fun capOcrTranscript(text: String): CappedOcrTranscript {
  var end = minOf(text.length, 50_000)
  if (end > 0 && Character.isHighSurrogate(text[end - 1])) end--
  return CappedOcrTranscript(text.substring(0, end), end < text.length)
}

/** OCR only accepts app-owned input. No provider/network URIs or private diagnostics. */
class StudyOcrModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  companion object {
    const val NAME = "TopicTrailOcr"
    private const val OCR_TIMEOUT_MS = 120_000L
    // Never reuse a request code during this process: a cancelled camera can return late,
    // including after the React context has been replaced.
    private val captureCodes = AtomicInteger(0x6000)
    private val recognitionBusy = AtomicBoolean(false)
    private val idPattern = Regex("[a-zA-Z0-9-]{1,100}")
    private val previewPattern = Regex("scan-[a-f0-9-]{36}\\.jpg")
    private val capturePattern = Regex("capture-[a-f0-9-]{36}\\.jpg")
  }
  private val executor = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private val previews = File(context.cacheDir, "topictrail-scan-previews-v1")
  private val captures = File(context.cacheDir, "topictrail-camera-v1")
  private val job = AtomicReference<Job?>(null)
  private class Job(val id: String, private val promise: Promise) {
    @Volatile var cancelled = false
    private var settled = false
    @Synchronized fun cancel(code: String, message: String) {
      cancelled = true
      fail(code, message)
    }
    @Synchronized fun fail(code: String, message: String) {
      if (!settled) { settled = true; promise.reject(code, message) }
    }
    @Synchronized fun succeed(value: WritableMap) {
      if (!settled && !cancelled) { settled = true; promise.resolve(value) }
    }
  }
  private class Capture(val id: String, val code: Int, val file: File, val uri: Uri, val promise: Promise) {
    @Volatile var cancelled = false
  }
  private var capture: Capture? = null // UI thread owns publication/cancellation.
  @Volatile private var disposed = false
  private val listener = object : BaseActivityEventListener() {
    override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
      val pending = capture?.takeIf { it.code == requestCode } ?: return
      revoke(pending)
      if (resultCode != Activity.RESULT_OK) { cancelCaptureOnMain(pending); return }
      // Ignore camera thumbnails/data URIs. Only EXTRA_OUTPUT's full-resolution file is read.
      submit({ cancelCaptureOnMain(pending) }) {
        var preview: WritableMap? = null
        try {
          preview = savePreview(normalizeImage(pending.file, false) { check(!disposed && !pending.cancelled) })
        } catch (_: Throwable) { /* The UI receives a fixed message below. */ }
        finally { pending.file.delete() }
        val result = preview
        main.post {
          if (capture !== pending || pending.cancelled || disposed) {
            result?.getString("uri")?.let { deletePreview(it) }
          } else {
            capture = null
            if (result == null) reject(pending.promise) else pending.promise.resolve(result)
          }
        }
      }
    }
  }
  init {
    context.addActivityEventListener(listener)
    executor.execute {
      // Only stale module-owned scratch, never library files or another live context's preview.
      val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
      listOf(previews to previewPattern, captures to capturePattern).forEach { (directory, pattern) ->
        try {
          scratchRoot(directory)
          directory.listFiles()?.filter { it.name.matches(pattern) && it.lastModified() < cutoff && it.canonicalFile == it.absoluteFile }
            ?.forEach { it.delete() }
        } catch (_: Exception) { /* Retry cleanup when this module next starts. */ }
      }
    }
  }
  override fun getName() = NAME
  override fun getConstants(): Map<String, Any> = mapOf("version" to 1, "engine" to "mlkit-16.0.1-latin-1", "bundledLatin" to true)
  private fun reject(promise: Promise) = promise.reject("SCAN_FAILED", "The photo or page could not be processed. Try a clearer image or choose a photo.")
  private fun submit(rejected: () -> Unit, action: () -> Unit) {
    try { executor.execute(action) } catch (_: RejectedExecutionException) { rejected() }
  }
  private fun scratchRoot(directory: File): File {
    val root = File(context.cacheDir.canonicalFile, directory.name)
    require(root.canonicalFile == root) // Do not follow a redirected scratch directory.
    return root
  }
  private fun ownedCache(value: String, directory: File, maxBytes: Long, pattern: Regex): File {
    val uri = Uri.parse(value)
    require(uri.scheme == "file" && uri.authority.isNullOrEmpty() && uri.query == null && uri.fragment == null)
    val candidate = File(uri.path ?: throw IOException())
    val root = scratchRoot(directory)
    require(candidate.name.matches(pattern) && candidate.parentFile?.canonicalFile == root && candidate.canonicalFile == File(root, candidate.name))
    require(candidate.isFile && candidate.length() in 1..maxBytes)
    return candidate
  }
  private fun previewFile(value: String) = ownedCache(value, previews, MAX_PREVIEW_BYTES, previewPattern)
  private fun deletePreview(value: String) {
    try { previewFile(value).delete() } catch (_: Exception) { /* Already released, absent, or not ours. */ }
  }
  private fun savePreview(bitmap: Bitmap): WritableMap {
    var file: File? = null
    try {
      require(bitmap.width in 1..MAX_SCAN_EDGE && bitmap.height in 1..MAX_SCAN_EDGE && bitmap.width.toLong() * bitmap.height <= MAX_SCAN_PIXELS)
      val directory = scratchRoot(previews)
      require(directory.mkdirs() || directory.isDirectory)
      file = File(directory, "scan-${UUID.randomUUID()}.jpg")
      require(file.createNewFile())
      file.outputStream().use { require(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
      require(file.length() in 1..MAX_PREVIEW_BYTES)
      // Keep the app context's public spelling so Expo can open the same file even when
      // Android resolves cacheDir through an alias. The private write used the canonical root.
      val clientFile = File(previews, file.name)
      require(clientFile.canonicalFile == file)
      return Arguments.createMap().apply {
        putString("uri", Uri.fromFile(clientFile).toString()); putInt("width", bitmap.width); putInt("height", bitmap.height)
      }
    } catch (error: Throwable) { file?.delete(); throw error }
    finally { bitmap.recycle() }
  }
  @ReactMethod fun normalizePhoto(value: String, rotate: Boolean, promise: Promise) {
    submit({ reject(promise) }) {
      var result: WritableMap? = null
      try {
        check(!disposed)
        val input = if (rotate) previewFile(value) else ownedCache(value, File(context.cacheDir, "topictrail-photo-input-v1"), MAX_IMAGE_BYTES, Regex("[a-zA-Z0-9-]{1,100}\\.tmp"))
        result = savePreview(normalizeImage(input, rotate) { check(!disposed) })
        check(!disposed)
        promise.resolve(result)
      } catch (_: Throwable) { result?.getString("uri")?.let { deletePreview(it) }; reject(promise) }
    }
  }
  /** Validate the same canonical owned preview used for OCR before Expo reads it for PDF creation. */
  @ReactMethod fun previewByteLength(value: String, promise: Promise) {
    val unavailable = { promise.reject("SCAN_PREVIEW_UNAVAILABLE", "The scan preview is unavailable.") }
    submit(unavailable) {
      try {
        check(!disposed)
        val path = Uri.parse(value).path ?: throw IOException()
        require(path.split('/').none { it == "." || it == ".." })
        promise.resolve(previewFile(value).length().toInt())
      } catch (_: Exception) { unavailable() }
    }
  }
  @ReactMethod fun releasePhoto(value: String) { submit({}, { deletePreview(value) }) }
  private fun revoke(pending: Capture) {
    try { context.revokeUriPermission(pending.uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION) }
    catch (_: Exception) { /* Already revoked by Android. */ }
  }
  private fun cancelCaptureOnMain(pending: Capture) {
    pending.cancelled = true
    revoke(pending)
    pending.file.delete()
    if (capture === pending) { capture = null; pending.promise.resolve(null) }
  }
  @ReactMethod fun capturePhoto(id: String, promise: Promise) {
    main.post {
      if (disposed || !id.matches(idPattern) || capture != null) {
        promise.reject("CAMERA_BUSY", "Finish the current camera action before taking another photo.")
        return@post
      }
      var file: File? = null
      var pending: Capture? = null
      try {
        val activity = context.currentActivity ?: throw IOException()
        val code = captureCodes.getAndIncrement()
        require(code <= 0xffff)
        val directory = scratchRoot(captures)
        require(directory.mkdirs() || directory.isDirectory)
        file = File(directory, "capture-${UUID.randomUUID()}.jpg")
        require(file.createNewFile())
        val uri = FileProvider.getUriForFile(context, context.packageName + ".scan.capture", file)
        pending = Capture(id, code, file, uri, promise)
        capture = pending
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
          putExtra(MediaStore.EXTRA_OUTPUT, uri)
          clipData = ClipData.newRawUri("TopicTrail capture", uri)
          addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        activity.startActivityForResult(intent, code)
      } catch (_: Exception) {
        pending?.let { revoke(it); if (capture === it) capture = null }
        file?.delete()
        promise.reject("CAMERA_UNAVAILABLE", "The camera is unavailable or permission was declined. Choose a photo instead.")
      }
    }
  }
  @ReactMethod fun cancelCapture(id: String) { main.post { capture?.takeIf { it.id == id }?.let { cancelCaptureOnMain(it) } } }
  private fun failRecognition(pending: Job, stage: String, error: Throwable?) {
    val engineCode = (error as? com.google.mlkit.common.MlKitException)?.errorCode
    val code = when {
      error is OutOfMemoryError -> "OCR_MEMORY"
      engineCode == com.google.mlkit.common.MlKitException.UNAVAILABLE -> "OCR_ENGINE_UNAVAILABLE"
      else -> stage
    }
    // Exception messages can contain private paths or input data. Log only stage, class and numeric SDK code.
    android.util.Log.w("TopicTrailOcr", "stage=$stage code=$code sdk=$engineCode type=${error?.javaClass?.name} cause=${error?.cause?.javaClass?.name}")
    pending.fail(code, "On-device text recognition could not finish.")
  }

  private fun recognize(id: String, promise: Promise, inputStage: String, input: (() -> Unit) -> Bitmap) {
    val pending = Job(id, promise)
    if (disposed || !id.matches(idPattern) || !recognitionBusy.compareAndSet(false, true)) {
      promise.reject("OCR_BUSY", "A page is still finishing. Try again shortly."); return
    }
    job.set(pending)
    val timeout = Runnable { pending.cancel("OCR_TIMEOUT", "Recognition took too long. Try a clearer scan.") }
    main.postDelayed(timeout, OCR_TIMEOUT_MS)
    fun complete() {
      main.removeCallbacks(timeout)
      job.compareAndSet(pending, null)
      recognitionBusy.set(false)
      if (disposed) executor.shutdown()
    }
    submit({ pending.fail("OCR_CANCELLED", "Recognition cancelled."); complete() }) {
      var bitmap: Bitmap? = null
      var recognizer: com.google.mlkit.vision.text.TextRecognizer? = null
      var stage = inputStage
      try {
        val checkActive = { check(!pending.cancelled && !disposed) }
        checkActive()
        val image = input(checkActive); bitmap = image
        require(image.width.toLong() * image.height <= MAX_SCAN_PIXELS)
        checkActive()
        stage = "OCR_ENGINE_INIT"
        val engine = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS); recognizer = engine
        stage = "OCR_ENGINE_PROCESS"
        engine.process(InputImage.fromBitmap(image, 0)).addOnCompleteListener(executor) { task ->
          try {
            if (pending.cancelled || disposed) pending.cancel("OCR_CANCELLED", "Recognition cancelled.")
            else if (!task.isSuccessful) failRecognition(pending, stage, task.exception)
            else {
              val transcript = capOcrTranscript(task.result.text)
              pending.succeed(Arguments.createMap().apply {
                putString("text", transcript.text); putNull("confidence"); putBoolean("truncated", transcript.truncated)
              })
            }
          } catch (error: Throwable) {
            failRecognition(pending, stage, error)
          } finally {
            try { image.recycle(); engine.close() } finally { complete() }
          }
        }
      } catch (error: Throwable) {
        try { bitmap?.recycle(); recognizer?.close() }
        finally {
          failRecognition(pending, stage, error)
          complete()
        }
      }
    }
  }
  @ReactMethod fun recognizePhoto(value: String, id: String, promise: Promise) = recognize(id, promise, "OCR_PREVIEW") { active ->
    decodeScanPreview(previewFile(value), active)
  }
  @ReactMethod fun recognizePdf(value: String, hash: String, page: Double, id: String, promise: Promise) = recognize(id, promise, "OCR_PDF_INPUT") { active ->
    require(page.isFinite() && page == page.toInt().toDouble())
    renderOwnedPdf(context, value, hash, page.toInt(), active)
  }
  @ReactMethod fun cancelOcr(id: String) {
    job.get()?.takeIf { it.id == id }?.cancel("OCR_CANCELLED", "Recognition cancelled.")
    // ML Kit Tasks cannot be cancelled. Keep the slot and Bitmap until actual completion,
    // even after timeout, so a retry cannot allocate a second in-flight recognition task.
  }
  override fun invalidate() {
    disposed = true
    job.get()?.cancel("OCR_CANCELLED", "Recognition cancelled.")
    main.post { capture?.let { cancelCaptureOnMain(it) }; context.removeActivityEventListener(listener) }
    submit({}) { if (job.get() == null) executor.shutdown() }
    super.invalidate()
  }
}

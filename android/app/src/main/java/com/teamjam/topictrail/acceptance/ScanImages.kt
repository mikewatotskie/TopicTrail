package com.teamjam.topictrail.acceptance

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import androidx.exifinterface.media.ExifInterface
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.security.MessageDigest
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

class ScanCaptureProvider : FileProvider()

internal const val MAX_SCAN_PIXELS = 4_000_000
internal const val MAX_SCAN_EDGE = 8192
internal const val MAX_IMAGE_BYTES = 50L * 1024 * 1024
internal const val MAX_PREVIEW_BYTES = 16L * 1024 * 1024

private fun renderScale(width: Int, height: Int, limit: Double): Double {
  require(width > 0 && height > 0)
  return min(min(limit, sqrt(MAX_SCAN_PIXELS.toDouble() / (width.toDouble() * height))),
    MAX_SCAN_EDGE.toDouble() / max(width, height))
}

internal fun scanDecodeSample(width: Int, height: Int): Int {
  require(width in 1..65535 && height in 1..65535)
  var sample = 1
  fun sampled(edge: Int) = (edge.toLong() + sample - 1) / sample
  while (sampled(width) * sampled(height) > MAX_SCAN_PIXELS ||
    max(sampled(width), sampled(height)) > MAX_SCAN_EDGE) sample *= 2
  return sample
}

internal fun scanOrientationTransform(orientation: Int): FloatArray = when (orientation) {
  ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> floatArrayOf(-1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
  ExifInterface.ORIENTATION_ROTATE_180 -> floatArrayOf(-1f, 0f, 0f, 0f, -1f, 0f, 0f, 0f, 1f)
  ExifInterface.ORIENTATION_FLIP_VERTICAL -> floatArrayOf(1f, 0f, 0f, 0f, -1f, 0f, 0f, 0f, 1f)
  ExifInterface.ORIENTATION_TRANSPOSE -> floatArrayOf(0f, 1f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)
  ExifInterface.ORIENTATION_ROTATE_90 -> floatArrayOf(0f, -1f, 0f, 1f, 0f, 0f, 0f, 0f, 1f)
  ExifInterface.ORIENTATION_TRANSVERSE -> floatArrayOf(0f, -1f, 0f, -1f, 0f, 0f, 0f, 0f, 1f)
  ExifInterface.ORIENTATION_ROTATE_270 -> floatArrayOf(0f, 1f, 0f, -1f, 0f, 0f, 0f, 0f, 1f)
  else -> floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
}

internal fun normalizeImage(file: File, quarterTurn: Boolean, checkActive: () -> Unit = {}): Bitmap {
  checkActive()
  require(file.length() in 1..MAX_IMAGE_BYTES)
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeFile(file.absolutePath, bounds)
  require(bounds.outMimeType == "image/jpeg" || bounds.outMimeType == "image/png")
  require(bounds.outWidth in 1..65535 && bounds.outHeight in 1..65535)
  // Round UP when estimating decoder dimensions. Bound the decode itself, not just
  // the final image, including very thin images and power-of-two boundary cases.
  val sample = scanDecodeSample(bounds.outWidth, bounds.outHeight)
  val exif = ExifInterface(file)
  checkActive()
  val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
  val decoded = BitmapFactory.decodeFile(file.absolutePath, options) ?: throw IOException()
  try {
    require(decoded.width.toLong() * decoded.height <= MAX_SCAN_PIXELS && max(decoded.width, decoded.height) <= MAX_SCAN_EDGE)
    checkActive()
    val downscale = renderScale(decoded.width, decoded.height, 1.0).toFloat()
    // Explicit EXIF transforms preserve all four mirrored orientations. In particular
    // transpose (5) and transverse (7) must not become ordinary quarter turns.
    val transform = scanOrientationTransform(exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL))
    val matrix = Matrix().apply { setValues(transform); postScale(downscale, downscale); if (quarterTurn) postRotate(90f) }
    val rect = android.graphics.RectF(0f, 0f, decoded.width.toFloat(), decoded.height.toFloat())
    matrix.mapRect(rect)
    matrix.postTranslate(-rect.left, -rect.top)
    val result = Bitmap.createBitmap(max(1, rect.width().toInt()), max(1, rect.height().toInt()), Bitmap.Config.ARGB_8888)
    try {
      require(result.width.toLong() * result.height <= MAX_SCAN_PIXELS && max(result.width, result.height) <= MAX_SCAN_EDGE)
      Canvas(result).apply {
        drawColor(Color.WHITE)
        drawBitmap(decoded, matrix, Paint(Paint.FILTER_BITMAP_FLAG))
      }
      checkActive()
      return result
    } catch (error: Throwable) { result.recycle(); throw error }
  } finally { decoded.recycle() }
}

/** Owned previews were already rotated, resized and re-encoded by savePreview. */
internal fun decodeScanPreview(file: File, checkActive: () -> Unit): Bitmap {
  checkActive()
  require(file.length() in 1..MAX_PREVIEW_BYTES)
  val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
  BitmapFactory.decodeFile(file.absolutePath, bounds)
  require(bounds.outMimeType == "image/jpeg" && bounds.outWidth in 1..MAX_SCAN_EDGE &&
    bounds.outHeight in 1..MAX_SCAN_EDGE && bounds.outWidth.toLong() * bounds.outHeight <= MAX_SCAN_PIXELS)
  checkActive()
  val bitmap = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 })
    ?: throw IOException()
  try {
    require(bitmap.width == bounds.outWidth && bitmap.height == bounds.outHeight)
    checkActive()
    return bitmap
  } catch (error: Throwable) { bitmap.recycle(); throw error }
}

internal fun renderOwnedPdf(context: Context, value: String, expectedHash: String, page: Int, checkActive: () -> Unit = {}): Bitmap {
  checkActive()
  require(page in 1..100000 && expectedHash.matches(Regex("[0-9a-f]{64}")))
  val uri = Uri.parse(value)
  require(uri.scheme == "file" && uri.authority.isNullOrEmpty() && uri.query == null && uri.fragment == null)
  val root = context.filesDir.canonicalFile
  val candidate = File(uri.path ?: throw IOException())
  // /data/data and /data/user/0 can name the same app directory. Require an exact
  // owned document subpath and reject any symlink beneath that root.
  val parts = candidate.path.split(File.separatorChar)
  val start = parts.indexOfLast { it == "files" }
  require(start > 0 && File(parts.take(start + 1).joinToString(File.separator)).canonicalFile == root)
  val relative = parts.drop(start + 1).joinToString("/")
  require(relative.endsWith(".pdf"))
  val owned = StudyArchive.owned(root, relative)
  require(owned.isFile && owned.length() in 1..StudyArchive.MAX_DOCUMENT.toLong())
  val expectedBytes = owned.length()
  FileInputStream(owned).use { stream ->
    val digest = MessageDigest.getInstance("SHA-256")
    val block = ByteArray(32 * 1024)
    var size = 0L
    while (true) {
      checkActive()
      val n = stream.read(block)
      if (n < 0) break
      size += n
      require(size <= StudyArchive.MAX_DOCUMENT)
      digest.update(block, 0, n)
    }
    val hex = digest.digest().joinToString("") { "%02x".format(it) }
    require(size == expectedBytes && hex == expectedHash)
    checkActive()
    stream.channel.position(0)
    val descriptor = ParcelFileDescriptor.dup(stream.fd)
    val renderer = try { PdfRenderer(descriptor) } catch (error: Throwable) { descriptor.close(); throw error }
    renderer.use {
      require(page <= it.pageCount)
      val rendered = it.openPage(page - 1)
      rendered.use { pdfPage ->
        val scale = renderScale(pdfPage.width, pdfPage.height, 2.5)
        val w = max(1, (pdfPage.width * scale).toInt())
        val h = max(1, (pdfPage.height * scale).toInt())
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        try {
          require(w.toLong() * h <= MAX_SCAN_PIXELS && max(w, h) <= MAX_SCAN_EDGE)
          bitmap.eraseColor(Color.WHITE)
          pdfPage.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
          checkActive()
          return bitmap
        } catch (error: Throwable) { bitmap.recycle(); throw error }
      }
    }
  }
}

package com.teamjam.topictrail.acceptance

import com.facebook.react.bridge.*
import java.io.File
import java.util.concurrent.Executors

class StudyMetadataModule(private val context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  companion object { const val NAME = "TopicTrailStudyMetadata" }
  private val worker = Executors.newSingleThreadExecutor()
  private val store by lazy { StudyMetadataStore(File(context.noBackupFilesDir, "study-metadata-v1.db")) }
  override fun getName() = NAME

  private fun execute(promise: Promise, block: () -> Any?) {
    if (context.packageName != "com.teamjam.topictrail") {
      promise.reject("TRANSFER_UNAVAILABLE", "This build does not use the private study database.")
      return
    }
    worker.execute {
      try { promise.resolve(block()) }
      catch (_: Exception) { promise.reject("TRANSFER_STORAGE", "Study data could not be read or saved. Existing records have been preserved.") }
    }
  }

  private fun values(input: ReadableArray): List<String?> {
    require(input.size() <= 32768)
    return (0 until input.size()).map { input.getString(it) }
  }
  private fun strings(input: ReadableArray) = values(input).map { requireNotNull(it) }

  @ReactMethod
  fun read(keys: ReadableArray, promise: Promise) {
    execute(promise) {
      Arguments.createArray().apply {
        for (value in store.read(strings(keys))) {
          if (value == null) pushNull() else pushString(value)
        }
      }
    }
  }

  @ReactMethod
  fun compareAndSet(keys: ReadableArray, previous: ReadableArray, next: ReadableArray, promise: Promise) {
    execute(promise) { store.compareAndSet(strings(keys), values(previous), strings(next)) }
  }

  override fun invalidate() {
    worker.execute { store.close() }
    worker.shutdown()
    super.invalidate()
  }
}

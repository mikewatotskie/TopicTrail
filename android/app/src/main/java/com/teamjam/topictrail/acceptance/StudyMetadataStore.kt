package com.teamjam.topictrail.acceptance

import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteDatabaseCorruptException
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.ByteBuffer

/** The production application's study-only metadata store. Each batch is a single snapshot/CAS.
 * Values are split into small BLOBs so no individual CursorWindow must hold a whole library.
 */
internal class StudyMetadataStore(private val file: File) {
  companion object {
    private const val CHUNK_BYTES = 128 * 1024
    private const val MAX_VALUE = 32 * 1024 * 1024
    private const val MAX_BATCH_KEYS = 32768
    private const val MAX_BATCH_BYTES = 48L * 1024 * 1024
    private const val ACCOUNT = "[a-z0-9]{20}/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}"
    private val allowed = Regex(
      "guest/(?:documents|bookmarks|progress/(?:pdf|docx|pptx)/[a-zA-Z0-9_-]{1,160})" +
        "|account/$ACCOUNT/library|notes/(?:guest|$ACCOUNT)|receipts/(?:guest|$ACCOUNT)/[0-9a-f]{64}"
    )
  }

  private var db: SQLiteDatabase? = null

  private fun database(): SQLiteDatabase {
    db?.let { return it }
    // Do not let Android's default corruption handler silently delete an unreadable study library.
    val corrupt = DatabaseErrorHandler { throw SQLiteDatabaseCorruptException("Study database requires recovery.") }
    val opened = SQLiteDatabase.openDatabase(file.absolutePath, null, SQLiteDatabase.CREATE_IF_NECESSARY, corrupt)
    try {
      if (opened.version == 0) {
        opened.beginTransaction()
        try {
          opened.execSQL("CREATE TABLE study (name TEXT NOT NULL, part INTEGER NOT NULL, bytes BLOB NOT NULL," +
            " PRIMARY KEY(name, part)) WITHOUT ROWID")
          opened.version = 1
          opened.setTransactionSuccessful()
        } finally { opened.endTransaction() }
      } else if (opened.version != 1) throw IllegalStateException("Unsupported study database.")
      db = opened
      return opened
    } catch (error: Exception) { opened.close(); throw error }
  }

  private fun validateKeys(keys: List<String>) {
    require(keys.size <= MAX_BATCH_KEYS && keys.distinct().size == keys.size && keys.all(allowed::matches))
  }

  private fun readBytes(sql: SQLiteDatabase, key: String): ByteArray? {
    sql.rawQuery("SELECT part, bytes FROM study WHERE name = ? ORDER BY part", arrayOf(key)).use { cursor ->
      if (!cursor.moveToFirst()) return null
      val out = ByteArrayOutputStream()
      var part = 0
      do {
        val chunk = cursor.getBlob(1)
        require(cursor.getInt(0) == part++ && chunk.size <= CHUNK_BYTES && out.size() <= MAX_VALUE - chunk.size)
        out.write(chunk)
      } while (cursor.moveToNext())
      return out.toByteArray()
    }
  }

  private fun write(sql: SQLiteDatabase, key: String, value: ByteArray) {
    sql.delete("study", "name = ?", arrayOf(key))
    sql.compileStatement("INSERT INTO study(name, part, bytes) VALUES (?, ?, ?)").use { insert ->
      insert.bindString(1,key)
      var part = 0
      var at = 0
      do {
        val end = minOf(value.size, at + CHUNK_BYTES)
        insert.bindLong(2,part++.toLong())
        insert.bindBlob(3,value.copyOfRange(at,end))
        insert.executeInsert()
        at = end
      } while (at < value.size)
    }
  }

  fun read(keys: List<String>): List<String?> {
    validateKeys(keys)
    val sql = database()
    var total = 0L
    sql.beginTransaction()
    try {
      val result = keys.map { key ->
        readBytes(sql, key)?.let { bytes ->
          total += bytes.size
          require(total <= MAX_BATCH_BYTES)
          Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
        }
      }
      sql.setTransactionSuccessful()
      return result
    } finally { sql.endTransaction() }
  }

  fun compareAndSet(keys: List<String>, previous: List<String?>, next: List<String>): Boolean {
    validateKeys(keys)
    require(keys.size == previous.size && keys.size == next.size)
    val sql = database()
    sql.beginTransaction()
    try {
      for ((index, key) in keys.withIndex()) {
        val before = previous[index]?.toByteArray(Charsets.UTF_8)
        if (before != null) require(before.size <= MAX_VALUE)
        if (!(readBytes(sql, key) contentEquals before)) return false
      }
      var total = 0L
      for ((index, key) in keys.withIndex()) {
        val value = next[index].toByteArray(Charsets.UTF_8)
        total += value.size
        require(value.size <= MAX_VALUE && total <= MAX_BATCH_BYTES)
        write(sql, key, value)
      }
      sql.setTransactionSuccessful()
      return true
    } finally { sql.endTransaction() }
  }

  fun close() { db?.close(); db = null }
}

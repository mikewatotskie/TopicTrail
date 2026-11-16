package com.teamjam.topictrail.acceptance

import android.database.sqlite.SQLiteDatabase
import java.io.File

/** On a disposable emulator, pass a fresh shell-owned database under /data/local/tmp.
 * Runs against the production store and Android's actual SQLite implementation.
 */
object StudyMetadataDeviceCheck {
  @JvmStatic fun main(args: Array<String>) {
    val file = File(args.single()).canonicalFile
    require(file.path.startsWith("/data/local/tmp/topictrail-transfer-") && !file.exists())
    val guest = "guest/documents"
    val notes = "notes/guest"
    val account = "account/abcdefghijklmnopqrst/11111111-2222-3333-4444-555555555555/library"
    var store = StudyMetadataStore(file)
    val large = "λ".repeat(1_500_000)
    check(store.read(listOf(guest, account)) == listOf(null, null))
    check(store.compareAndSet(listOf(guest, notes, account), listOf(null, null, null), listOf("guest-only", "draft", large)))
    check(store.read(listOf(guest, notes, account)) == listOf("guest-only", "draft", large))
    check(!store.compareAndSet(listOf(guest,notes), listOf("stale", "draft"), listOf("overwritten", "overwritten")))
    check(store.read(listOf(guest,notes)) == listOf("guest-only", "draft"))
    check(runCatching { store.read(listOf("SecureStore")) }.isFailure)
    check(runCatching { store.read(listOf(guest, guest)) }.isFailure)
    val receipt = "receipts/guest/" + "a".repeat(64)
    // Fail on the third row, after an actual write of the other two values.
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
      db.execSQL("CREATE TRIGGER force_failure BEFORE INSERT ON study WHEN NEW.name LIKE 'receipts/%' BEGIN SELECT RAISE(ABORT, 'injected interruption'); END")
    }
    check(runCatching {
      store.compareAndSet(listOf(guest,notes,receipt), listOf("guest-only","draft",null), listOf("changed","changed","receipt"))
    }.isFailure)
    store.close()
    store = StudyMetadataStore(file)
    check(store.read(listOf(guest, notes, receipt, account)) == listOf("guest-only", "draft", null, large))
    SQLiteDatabase.openDatabase(file.path, null, SQLiteDatabase.OPEN_READWRITE).use { db -> db.execSQL("DROP TRIGGER force_failure") }
    check(store.compareAndSet(listOf(guest,notes,receipt), listOf("guest-only","draft",null), listOf("restored","draft retained","receipt")))
    check(!store.compareAndSet(listOf(guest,notes,receipt), listOf("guest-only","draft",null), listOf("changed","changed","duplicate")))
    check(store.read(listOf(guest,notes,receipt,account)) == listOf("restored","draft retained","receipt",large))
    store.close()
    println("PASS Android SQLite 3 MB CursorWindow roundtrip, scope keys, stale CAS, third-write failure rollback, reopen, receipt and duplicate replay.")
  }
}


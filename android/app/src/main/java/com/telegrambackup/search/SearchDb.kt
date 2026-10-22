package com.telegrambackup.search

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Calendar
import java.util.Locale
import kotlin.math.ln

/**
 * The on-device search index.
 *
 * Its own database file, owned only by Kotlin. JS never opens it: op-sqlite
 * bundles its own SQLite, and two SQLite libraries holding locks on one file
 * in one process can corrupt it. JS talks to this through SearchModule.
 *
 * `items` holds one row per backed-up file; `items_fts` (FTS4, docid =
 * items.id) is what queries hit. Names and folders are searchable the moment
 * a file is enqueued; labels and recognised text arrive when the worker gets
 * to it.
 */
class SearchDb private constructor(context: Context) :
    SQLiteOpenHelper(context.applicationContext, NAME, null, VERSION) {

    init {
        // Searches read while the worker writes; WAL keeps them from blocking.
        setWriteAheadLoggingEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE items (
              id INTEGER PRIMARY KEY,
              path TEXT NOT NULL UNIQUE,
              message_id INTEGER NOT NULL,
              topic_id INTEGER,
              name TEXT NOT NULL,
              folder TEXT NOT NULL,
              kind TEXT NOT NULL,
              size INTEGER NOT NULL,
              mtime INTEGER NOT NULL,
              encrypted INTEGER NOT NULL DEFAULT 0,
              deep INTEGER NOT NULL DEFAULT 1,
              taken_at INTEGER NOT NULL DEFAULT 0,
              labels TEXT NOT NULL DEFAULT '',
              ocr TEXT NOT NULL DEFAULT '',
              state INTEGER NOT NULL DEFAULT 0,
              model_ver INTEGER NOT NULL DEFAULT 0,
              attempts INTEGER NOT NULL DEFAULT 0
            )
            """.trimIndent(),
        )
        // The worker takes pending rows smallest-first, so this is its index.
        db.execSQL("CREATE INDEX items_state ON items(state, size)")
        try {
            db.execSQL(
                "CREATE VIRTUAL TABLE items_fts USING fts4(name, folder, labels, ocr, extra, tokenize=unicode61)",
            )
        } catch (_: Throwable) {
            // unicode61 handles accents and non-Latin scripts better, but a
            // ROM without it still gets a working index.
            db.execSQL("CREATE VIRTUAL TABLE items_fts USING fts4(name, folder, labels, ocr, extra)")
        }
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // Derived data: rebuilding is always safe and cheap to re-feed.
        db.execSQL("DROP TABLE IF EXISTS items_fts")
        db.execSQL("DROP TABLE IF EXISTS items")
        onCreate(db)
    }

    /* ------------------------------------------------------------ enqueue */

    data class Incoming(
        val path: String,
        val messageId: Long,
        val topicId: Long?,
        val name: String,
        val kind: String,
        val size: Long,
        val mtime: Long,
        val encrypted: Boolean,
        val deep: Boolean,
    )

    /**
     * Adds or refreshes rows. A file whose bytes or depth setting changed
     * goes back to pending; one that only moved message (restored index)
     * keeps its labels. Returns how many rows now need the worker.
     */
    fun enqueue(items: List<Incoming>): Int {
        val db = writableDatabase
        var queued = 0
        db.beginTransaction()
        try {
            for (item in items) {
                db.rawQuery(
                    "SELECT id, size, mtime, deep, state FROM items WHERE path = ?",
                    arrayOf(item.path),
                ).use { cursor ->
                    if (!cursor.moveToFirst()) {
                        val values = baseValues(item).apply {
                            put("taken_at", item.mtime)
                            put("state", if (item.deep && needsWork(item.kind)) STATE_PENDING else STATE_DONE)
                            put("model_ver", MODEL_VERSION)
                        }
                        val id = db.insertOrThrow("items", null, values)
                        writeFts(db, id, item.name, item.path, "", "", item.kind, item.mtime, insert = true)
                        if (values.getAsInteger("state") == STATE_PENDING) queued += 1
                        return@use
                    }
                    val id = cursor.getLong(0)
                    val changed = cursor.getLong(1) != item.size || cursor.getLong(2) != item.mtime
                    val deeper = cursor.getInt(3) == 0 && item.deep
                    // Opting a folder out must also forget what was read from it.
                    val shallower = cursor.getInt(3) == 1 && !item.deep
                    val values = baseValues(item)
                    if (changed || deeper || shallower) {
                        val pending = item.deep && needsWork(item.kind)
                        values.put("state", if (pending) STATE_PENDING else STATE_DONE)
                        values.put("labels", "")
                        values.put("ocr", "")
                        values.put("attempts", 0)
                        values.put("taken_at", item.mtime)
                        if (pending) queued += 1
                        db.update("items", values, "id = ?", arrayOf(id.toString()))
                        writeFts(db, id, item.name, item.path, "", "", item.kind, item.mtime, insert = false)
                    } else {
                        db.update("items", values, "id = ?", arrayOf(id.toString()))
                        if (cursor.getInt(4) == STATE_PENDING) queued += 1
                    }
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        return queued
    }

    private fun baseValues(item: Incoming) = ContentValues().apply {
        put("path", item.path)
        put("message_id", item.messageId)
        if (item.topicId == null) putNull("topic_id") else put("topic_id", item.topicId)
        put("name", item.name)
        put("folder", folderOf(item.path))
        put("kind", item.kind)
        put("size", item.size)
        put("mtime", item.mtime)
        put("encrypted", if (item.encrypted) 1 else 0)
        put("deep", if (item.deep) 1 else 0)
    }

    /** Drops rows whose file is no longer in the backup index. */
    fun reconcile(keep: Collection<String>): Int {
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.execSQL("CREATE TEMP TABLE IF NOT EXISTS keep_paths (path TEXT PRIMARY KEY)")
            db.execSQL("DELETE FROM keep_paths")
            val insert = db.compileStatement("INSERT OR IGNORE INTO keep_paths (path) VALUES (?)")
            for (path in keep) {
                insert.bindString(1, path)
                insert.executeInsert()
                insert.clearBindings()
            }
            db.execSQL(
                "DELETE FROM items_fts WHERE docid IN (SELECT id FROM items WHERE path NOT IN (SELECT path FROM keep_paths))",
            )
            val removed = db.delete("items", "path NOT IN (SELECT path FROM keep_paths)", null)
            db.execSQL("DELETE FROM keep_paths")
            db.setTransactionSuccessful()
            return removed
        } finally {
            db.endTransaction()
        }
    }

    /** Sends every analysable row back to the worker (settings changed). */
    fun requeueAll(): Int {
        val db = writableDatabase
        val values = ContentValues().apply {
            put("state", STATE_PENDING)
            put("attempts", 0)
        }
        return db.update(
            "items",
            values,
            "deep = 1 AND kind IN ('image', 'video', 'pdf', 'text')",
            null,
        )
    }

    /** Rows indexed by an older model version go back to pending. */
    fun requeueOutdated() {
        writableDatabase.execSQL(
            "UPDATE items SET state = $STATE_PENDING, attempts = 0 WHERE state = $STATE_DONE AND deep = 1 AND model_ver < $MODEL_VERSION AND kind IN ('image', 'video', 'pdf', 'text')",
        )
    }

    fun clear() {
        val db = writableDatabase
        db.execSQL("DELETE FROM items_fts")
        db.execSQL("DELETE FROM items")
    }

    /* ------------------------------------------------------------- worker */

    data class Pending(
        val id: Long,
        val path: String,
        val name: String,
        val kind: String,
        val size: Long,
        val mtime: Long,
        val attempts: Int,
    )

    fun nextPending(limit: Int, excludeIds: Set<Long>): List<Pending> {
        val out = ArrayList<Pending>()
        readableDatabase.rawQuery(
            "SELECT id, path, name, kind, size, mtime, attempts FROM items WHERE state = $STATE_PENDING ORDER BY size LIMIT ?",
            arrayOf((limit + excludeIds.size).toString()),
        ).use { cursor ->
            while (cursor.moveToNext() && out.size < limit) {
                val id = cursor.getLong(0)
                if (id in excludeIds) continue
                out.add(
                    Pending(
                        id = id,
                        path = cursor.getString(1),
                        name = cursor.getString(2),
                        kind = cursor.getString(3),
                        size = cursor.getLong(4),
                        mtime = cursor.getLong(5),
                        attempts = cursor.getInt(6),
                    ),
                )
            }
        }
        return out
    }

    data class Analysis(
        val id: Long,
        val labels: String,
        val ocr: String,
        val takenAt: Long?,
        val failed: Boolean,
    )

    /** Writes a batch of worker results in one transaction. */
    fun saveResults(results: List<Analysis>) {
        if (results.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            for (result in results) {
                db.rawQuery(
                    "SELECT name, path, kind, mtime, attempts FROM items WHERE id = ?",
                    arrayOf(result.id.toString()),
                ).use { cursor ->
                    if (!cursor.moveToFirst()) return@use
                    val name = cursor.getString(0)
                    val path = cursor.getString(1)
                    val kind = cursor.getString(2)
                    val mtime = cursor.getLong(3)
                    val attempts = cursor.getInt(4) + 1
                    val values = ContentValues()
                    if (result.failed) {
                        values.put("attempts", attempts)
                        // Two strikes: a file that crashes the decoder twice is
                        // left name-searchable rather than retried forever.
                        values.put("state", if (attempts >= MAX_ATTEMPTS) STATE_FAILED else STATE_PENDING)
                    } else {
                        val takenAt = result.takenAt ?: mtime
                        values.put("labels", result.labels)
                        values.put("ocr", result.ocr)
                        values.put("taken_at", takenAt)
                        values.put("state", STATE_DONE)
                        values.put("model_ver", MODEL_VERSION)
                        writeFts(db, result.id, name, path, result.labels, result.ocr, kind, takenAt, insert = false)
                    }
                    db.update("items", values, "id = ?", arrayOf(result.id.toString()))
                }
            }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    data class Stats(val total: Int, val done: Int, val pending: Int, val failed: Int)

    fun stats(): Stats {
        readableDatabase.rawQuery(
            "SELECT COUNT(*), " +
                "SUM(CASE WHEN state = $STATE_DONE THEN 1 ELSE 0 END), " +
                "SUM(CASE WHEN state = $STATE_PENDING THEN 1 ELSE 0 END), " +
                "SUM(CASE WHEN state = $STATE_FAILED THEN 1 ELSE 0 END) FROM items",
            null,
        ).use { cursor ->
            cursor.moveToFirst()
            return Stats(cursor.getInt(0), cursor.getInt(1), cursor.getInt(2), cursor.getInt(3))
        }
    }

    /* -------------------------------------------------------------- query */

    data class Hit(
        val path: String,
        val messageId: Long,
        val topicId: Long?,
        val name: String,
        val kind: String,
        val size: Long,
        val takenAt: Long,
        val encrypted: Boolean,
        val snippet: String,
        val score: Double,
    )

    /**
     * Ranked full-text search.
     *
     * Every word must match (implicit AND), each as a prefix, so "rec" finds
     * "receipt". Ranking weighs which column matched: a hit in the name or a
     * label beats one buried in recognised text, rarer words count more, and
     * ties go to the newest file. Scoring runs here over matchinfo() because
     * FTS4 has no built-in rank.
     */
    fun search(query: String, includeEncrypted: Boolean, limit: Int): List<Hit> {
        val match = toMatchExpression(query) ?: return emptyList()
        val hits = ArrayList<Hit>()
        readableDatabase.rawQuery(
            """
            SELECT i.path, i.message_id, i.topic_id, i.name, i.kind, i.size, i.taken_at, i.encrypted,
                   matchinfo(items_fts, 'pcx'),
                   snippet(items_fts, '[', ']', '…', 3, 12)
            FROM items_fts JOIN items i ON i.id = items_fts.docid
            WHERE items_fts MATCH ? AND (? = 1 OR i.encrypted = 0)
            LIMIT $MAX_CANDIDATES
            """.trimIndent(),
            arrayOf(match, if (includeEncrypted) "1" else "0"),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val snippet = cursor.getString(9) ?: ""
                hits.add(
                    Hit(
                        path = cursor.getString(0),
                        messageId = cursor.getLong(1),
                        topicId = if (cursor.isNull(2)) null else cursor.getLong(2),
                        name = cursor.getString(3),
                        kind = cursor.getString(4),
                        size = cursor.getLong(5),
                        takenAt = cursor.getLong(6),
                        encrypted = cursor.getInt(7) == 1,
                        // Only worth showing when the match is in the text itself.
                        snippet = if (snippet.contains('[')) snippet else "",
                        score = score(cursor.getBlob(8)),
                    ),
                )
            }
        }
        return hits
            .sortedWith(compareByDescending<Hit> { it.score }.thenByDescending { it.takenAt })
            .take(limit)
    }

    companion object {
        private const val NAME = "search_index.db"
        private const val VERSION = 1

        /** Bump when the analysis changes, so old rows are redone. */
        const val MODEL_VERSION = 1

        const val STATE_PENDING = 0
        const val STATE_DONE = 1
        const val STATE_FAILED = 2
        private const val MAX_ATTEMPTS = 2
        private const val MAX_CANDIDATES = 3000

        /** name, folder, labels, ocr, extra */
        private val COLUMN_WEIGHTS = doubleArrayOf(3.0, 1.5, 2.5, 1.0, 0.8)

        @Volatile private var instance: SearchDb? = null

        fun get(context: Context): SearchDb =
            instance ?: synchronized(this) {
                instance ?: SearchDb(context).also { instance = it }
            }

        fun needsWork(kind: String): Boolean =
            kind == "image" || kind == "video" || kind == "pdf" || kind == "text"

        /** "/storage/emulated/0/DCIM/Camera/x.jpg" -> "DCIM Camera" */
        fun folderOf(path: String): String {
            val dir = path.substringBeforeLast('/', "")
            return dir
                .removePrefix("/storage/emulated/0")
                .replace(Regex("^/storage/[^/]+"), "")
                .split('/')
                .filter { it.isNotEmpty() }
                .joinToString(" ")
        }

        private val MONTHS = arrayOf(
            "january jan", "february feb", "march mar", "april apr", "may", "june jun",
            "july jul", "august aug", "september sep sept", "october oct", "november nov", "december dec",
        )

        private val KIND_WORDS = mapOf(
            "image" to "photo photos image images picture pictures pic pics",
            "video" to "video videos movie movies clip clips",
            "pdf" to "pdf document documents doc docs",
            "text" to "text document documents note notes",
            "audio" to "audio music song songs sound recording voice",
        )

        /** Words a person might type that the file itself never contains. */
        fun extraWords(kind: String, takenAt: Long): String {
            val calendar = Calendar.getInstance().apply { timeInMillis = takenAt * 1000 }
            val year = calendar.get(Calendar.YEAR)
            val month = MONTHS[calendar.get(Calendar.MONTH)]
            return listOfNotNull(KIND_WORDS[kind], year.toString(), month).joinToString(" ")
        }

        private fun writeFts(
            db: SQLiteDatabase,
            id: Long,
            name: String,
            path: String,
            labels: String,
            ocr: String,
            kind: String,
            takenAt: Long,
            insert: Boolean,
        ) {
            if (!insert) {
                db.execSQL("DELETE FROM items_fts WHERE docid = ?", arrayOf<Any>(id))
            }
            db.execSQL(
                "INSERT INTO items_fts (docid, name, folder, labels, ocr, extra) VALUES (?, ?, ?, ?, ?, ?)",
                arrayOf<Any>(id, name, folderOf(path), labels, ocr, extraWords(kind, takenAt)),
            )
        }

        /**
         * Turns free text into a safe FTS4 expression: letters and digits only
         * (so no user input can inject operators), each word a prefix term.
         */
        fun toMatchExpression(query: String): String? {
            val words = query
                .lowercase(Locale.ROOT)
                .split(Regex("[^\\p{L}\\p{N}]+"))
                .filter { it.isNotEmpty() }
                .take(8)
            if (words.isEmpty()) return null
            return words.joinToString(" ") { "$it*" }
        }

        /** matchinfo('pcx'): p phrases, c columns, then 3 ints per phrase x column. */
        private fun score(blob: ByteArray?): Double {
            if (blob == null || blob.size < 8) return 0.0
            val ints = ByteBuffer.wrap(blob).order(ByteOrder.nativeOrder()).asIntBuffer()
            val phrases = ints.get(0)
            val columns = ints.get(1)
            var total = 0.0
            for (p in 0 until phrases) {
                for (c in 0 until columns) {
                    val base = 2 + (p * columns + c) * 3
                    if (base + 2 >= ints.limit()) return total
                    val hitsHere = ints.get(base)
                    val docsWithHit = ints.get(base + 2)
                    if (hitsHere <= 0) continue
                    val weight = COLUMN_WEIGHTS.getOrElse(c) { 1.0 }
                    val rarity = ln(1.0 + 1000.0 / docsWithHit.coerceAtLeast(1))
                    total += weight * (1.0 + ln(hitsHere.toDouble())) * rarity
                }
            }
            return total
        }
    }
}

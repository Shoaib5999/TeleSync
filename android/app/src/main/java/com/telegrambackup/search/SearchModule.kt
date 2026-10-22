package com.telegrambackup.search

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray
import java.util.concurrent.Executors

/**
 * JS surface of the search index (see services/search/native.ts).
 *
 * Batches cross the bridge as one JSON string rather than thousands of
 * ReadableMaps, which is much cheaper for the first full feed. Queries run on
 * their own thread so typing never waits behind a large enqueue.
 */
class SearchModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    private val writeExecutor = Executors.newSingleThreadExecutor()
    private val queryExecutor = Executors.newSingleThreadExecutor()

    private val db get() = SearchDb.get(reactContext)

    override fun getName(): String = NAME

    @ReactMethod
    fun enqueue(itemsJson: String, promise: Promise) {
        writeExecutor.execute {
            try {
                val array = JSONArray(itemsJson)
                val items = ArrayList<SearchDb.Incoming>(array.length())
                for (i in 0 until array.length()) {
                    val o = array.getJSONObject(i)
                    items.add(
                        SearchDb.Incoming(
                            path = o.getString("path"),
                            messageId = o.getLong("messageId"),
                            topicId = if (o.isNull("topicId")) null else o.getLong("topicId"),
                            name = o.getString("name"),
                            kind = o.getString("kind"),
                            size = o.getLong("size"),
                            mtime = o.getLong("mtime"),
                            encrypted = o.getBoolean("encrypted"),
                            deep = o.getBoolean("deep"),
                        ),
                    )
                }
                promise.resolve(db.enqueue(items))
            } catch (error: Throwable) {
                promise.reject("E_SEARCH_ENQUEUE", error.message, error)
            }
        }
    }

    @ReactMethod
    fun reconcile(pathsJson: String, promise: Promise) {
        writeExecutor.execute {
            try {
                val array = JSONArray(pathsJson)
                val keep = HashSet<String>(array.length())
                for (i in 0 until array.length()) keep.add(array.getString(i))
                promise.resolve(db.reconcile(keep))
            } catch (error: Throwable) {
                promise.reject("E_SEARCH_RECONCILE", error.message, error)
            }
        }
    }

    @ReactMethod
    fun search(query: String, includeEncrypted: Boolean, limit: Int, promise: Promise) {
        queryExecutor.execute {
            try {
                val out = Arguments.createArray()
                for (hit in db.search(query, includeEncrypted, limit.coerceIn(1, 500))) {
                    out.pushMap(
                        Arguments.createMap().apply {
                            putString("path", hit.path)
                            putDouble("messageId", hit.messageId.toDouble())
                            if (hit.topicId == null) putNull("topicId") else putDouble("topicId", hit.topicId.toDouble())
                            putString("name", hit.name)
                            putString("kind", hit.kind)
                            putDouble("size", hit.size.toDouble())
                            putDouble("takenAt", hit.takenAt.toDouble())
                            putBoolean("encrypted", hit.encrypted)
                            putString("snippet", hit.snippet)
                        },
                    )
                }
                promise.resolve(out)
            } catch (error: Throwable) {
                promise.reject("E_SEARCH", error.message, error)
            }
        }
    }

    @ReactMethod
    fun stats(promise: Promise) {
        queryExecutor.execute {
            try {
                val stats = db.stats()
                promise.resolve(
                    Arguments.createMap().apply {
                        putInt("total", stats.total)
                        putInt("done", stats.done)
                        putInt("pending", stats.pending)
                        putInt("failed", stats.failed)
                    },
                )
            } catch (error: Throwable) {
                promise.reject("E_SEARCH_STATS", error.message, error)
            }
        }
    }

    @ReactMethod
    fun startIndexing(deepOcr: Boolean, chargingOnly: Boolean, replace: Boolean, promise: Promise) {
        try {
            IndexWorker.enqueue(reactContext, deepOcr, chargingOnly, replace)
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_SEARCH_START", error.message, error)
        }
    }

    @ReactMethod
    fun stopIndexing(promise: Promise) {
        try {
            IndexWorker.cancel(reactContext)
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_SEARCH_STOP", error.message, error)
        }
    }

    /** Sends every analysable file back through the models (settings changed). */
    @ReactMethod
    fun requeueAll(promise: Promise) {
        writeExecutor.execute {
            try {
                promise.resolve(db.requeueAll())
            } catch (error: Throwable) {
                promise.reject("E_SEARCH_REQUEUE", error.message, error)
            }
        }
    }

    @ReactMethod
    fun clear(promise: Promise) {
        writeExecutor.execute {
            try {
                db.clear()
                promise.resolve(true)
            } catch (error: Throwable) {
                promise.reject("E_SEARCH_CLEAR", error.message, error)
            }
        }
    }

    override fun invalidate() {
        writeExecutor.shutdown()
        queryExecutor.shutdown()
        super.invalidate()
    }

    companion object {
        const val NAME = "SearchNative"
    }
}

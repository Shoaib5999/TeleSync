package com.telegrambackup.index

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Streaming SHA-256 of a file on disk.
 *
 * Native because JS can only read a file through base64 slices, which turns a
 * 2 GB video into thousands of bridge round-trips. MessageDigest runs on the
 * CPU's SHA extensions where present (Conscrypt), so this is disk-bound.
 *
 * One worker thread: hashes are I/O heavy, and running several at once on
 * the same storage only makes each one slower.
 */
class FileHashModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    private val executor = Executors.newSingleThreadExecutor()

    override fun getName(): String = NAME

    @ReactMethod
    fun sha256(path: String, promise: Promise) {
        executor.execute {
            try {
                promise.resolve(hashFile(File(path)))
            } catch (error: Throwable) {
                promise.reject("E_HASH", error.message ?: "Could not hash $path", error)
            }
        }
    }

    override fun invalidate() {
        executor.shutdown()
        super.invalidate()
    }

    companion object {
        const val NAME = "FileHash"
        private const val BUFFER_BYTES = 1 shl 20

        fun hashFile(file: File): String {
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(BUFFER_BYTES)
            FileInputStream(file).use { input ->
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                }
            }
            val bytes = digest.digest()
            val hex = CharArray(bytes.size * 2)
            val digits = "0123456789abcdef"
            for (i in bytes.indices) {
                val v = bytes[i].toInt() and 0xff
                hex[i * 2] = digits[v ushr 4]
                hex[i * 2 + 1] = digits[v and 0x0f]
            }
            return String(hex)
        }
    }
}

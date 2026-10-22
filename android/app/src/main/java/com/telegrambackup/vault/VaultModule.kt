package com.telegrambackup.vault

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.view.WindowManager
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors

/**
 * Native helpers for the Vault tab.
 *
 * Both jobs are ones JS cannot do: flagging the window as secure, and
 * rendering PDF pages with the platform's PdfRenderer (no third-party PDF
 * library, so nothing new to keep compatible with the New Architecture).
 */
class VaultModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    /** PdfRenderer is not thread-safe; one worker keeps renders serial. */
    private val pdfExecutor = Executors.newSingleThreadExecutor()

    override fun getName(): String = NAME

    /**
     * FLAG_SECURE blocks screenshots and screen recording, and blanks the app's
     * preview in the recents screen, while the Vault is open.
     */
    @ReactMethod
    fun setSecure(enabled: Boolean, promise: Promise) {
        val activity = reactContext.currentActivity
        if (activity == null) {
            promise.resolve(false)
            return
        }
        activity.runOnUiThread {
            try {
                if (enabled) {
                    activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
                } else {
                    activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
                }
                promise.resolve(true)
            } catch (error: Throwable) {
                promise.reject("E_SECURE", error.message, error)
            }
        }
    }

    @ReactMethod
    fun pdfPageCount(path: String, promise: Promise) {
        pdfExecutor.execute {
            try {
                open(path).use { (_, renderer) -> promise.resolve(renderer.pageCount) }
            } catch (error: Throwable) {
                promise.reject("E_PDF", error.message ?: "Could not open PDF", error)
            }
        }
    }

    /**
     * Renders one page to a PNG at `width` pixels wide, keeping the aspect
     * ratio, and resolves { path, width, height }.
     */
    @ReactMethod
    fun renderPdfPage(path: String, page: Int, width: Int, outPath: String, promise: Promise) {
        pdfExecutor.execute {
            try {
                open(path).use { (_, renderer) ->
                    renderer.openPage(page).use { pdfPage ->
                        val targetWidth = width.coerceIn(200, 2400)
                        val targetHeight =
                            (targetWidth.toLong() * pdfPage.height / pdfPage.width.coerceAtLeast(1))
                                .toInt()
                                .coerceIn(1, 6000)
                        val bitmap = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
                        try {
                            // PDF pages are transparent by default; paper is white.
                            bitmap.eraseColor(Color.WHITE)
                            pdfPage.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            File(outPath).parentFile?.mkdirs()
                            FileOutputStream(outPath).use { out ->
                                bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
                            }
                        } finally {
                            bitmap.recycle()
                        }
                        val result = Arguments.createMap()
                        result.putString("path", outPath)
                        result.putInt("width", targetWidth)
                        result.putInt("height", targetHeight)
                        promise.resolve(result)
                    }
                }
            } catch (error: Throwable) {
                promise.reject("E_PDF", error.message ?: "Could not render PDF page", error)
            }
        }
    }

    private fun open(path: String): PdfHandle {
        val descriptor = ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY)
        return try {
            PdfHandle(descriptor, PdfRenderer(descriptor))
        } catch (error: Throwable) {
            descriptor.close()
            throw error
        }
    }

    /** Closes the renderer before the descriptor it reads from. */
    private data class PdfHandle(
        val descriptor: ParcelFileDescriptor,
        val renderer: PdfRenderer,
    ) : AutoCloseable {
        override fun close() {
            renderer.close()
            descriptor.close()
        }
    }

    override fun invalidate() {
        pdfExecutor.shutdown()
        super.invalidate()
    }

    companion object {
        const val NAME = "VaultNative"
    }
}

package com.telegrambackup.search

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.media.ExifInterface
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.ParcelFileDescriptor
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.common.MlKitException
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabeler
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.io.File
import java.io.FileInputStream
import java.nio.charset.CodingErrorAction
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.TimeUnit

/**
 * Turns one file into searchable words, entirely on the device.
 *
 * Cost control, since this runs over thousands of files:
 *  - every image is decoded ONCE, downsampled at decode time (inSampleSize)
 *    to about [TARGET_EDGE] px, and that one bitmap feeds both models;
 *  - labelling (cheap) runs first, and text recognition (dearer) only where
 *    text is likely: screenshots, documents, PDFs, or a photo whose labels
 *    suggest a sign, receipt, screen… unless deep OCR is on;
 *  - videos contribute two keyframes, PDFs their first pages, text files
 *    their first 64 KB, read directly with no model at all.
 *
 * Thread-safe: ML Kit clients may be shared across threads.
 */
class Indexer(private val deepOcr: Boolean) : AutoCloseable {

    /** ML Kit's models are not on the device yet (Play services downloads them). */
    class ModelUnavailable(cause: Throwable) : Exception(cause)

    data class Output(val labels: String, val text: String, val takenAt: Long?)

    private val labeler: ImageLabeler = ImageLabeling.getClient(
        ImageLabelerOptions.Builder().setConfidenceThreshold(LABEL_CONFIDENCE).build(),
    )
    private val recognizer: TextRecognizer =
        TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)

    fun analyse(path: String, name: String, kind: String): Output {
        val file = File(path)
        if (!file.isFile) {
            // Gone from the phone: still findable by name, nothing to read.
            return Output("", "", null)
        }
        return when (kind) {
            "image" -> analyseImage(path, name)
            "video" -> analyseVideo(path)
            "pdf" -> Output("", analysePdf(file), null)
            "text" -> Output("", readText(file), null)
            else -> Output("", "", null)
        }
    }

    /* ---------------------------------------------------------------- image */

    private fun analyseImage(path: String, name: String): Output {
        val exif = try { ExifInterface(path) } catch (_: Throwable) { null }
        val rotation = when (exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
            ExifInterface.ORIENTATION_ROTATE_90 -> 90
            ExifInterface.ORIENTATION_ROTATE_180 -> 180
            ExifInterface.ORIENTATION_ROTATE_270 -> 270
            else -> 0
        }
        val takenAt = exif?.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)?.let(::parseExifDate)

        val bitmap = decodeDownsampled(path) ?: return Output("", "", takenAt)
        try {
            val image = InputImage.fromBitmap(bitmap, rotation)
            val labels = label(image)
            val wantText = deepOcr || looksTextual(path, name) || labels.any { it in TEXTY_LABELS }
            val text = if (wantText) recognise(image) else ""
            return Output(expandLabels(labels), text, takenAt)
        } finally {
            bitmap.recycle()
        }
    }

    /** Decodes at the smallest power-of-two scale that keeps >= TARGET_EDGE px. */
    private fun decodeDownsampled(path: String): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        val width = bounds.outWidth
        val height = bounds.outHeight
        if (width <= 0 || height <= 0) return null
        var sample = 1
        while (maxOf(width, height) / (sample * 2) >= TARGET_EDGE) {
            sample *= 2
        }
        val options = BitmapFactory.Options().apply {
            inSampleSize = sample
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return BitmapFactory.decodeFile(path, options)
    }

    /* ---------------------------------------------------------------- video */

    private fun analyseVideo(path: String): Output {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(path)
            val durationMs = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull() ?: 0L
            val takenAt = retriever
                .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)
                ?.let(::parseVideoDate)

            // Early and middle: openings are often black, middles representative.
            val positionsUs = listOf(
                minOf(1_000L, durationMs / 4) * 1000,
                (durationMs / 2) * 1000,
            ).distinct()

            val labels = LinkedHashSet<String>()
            for (positionUs in positionsUs) {
                val frame = frameAt(retriever, positionUs) ?: continue
                try {
                    labels.addAll(label(InputImage.fromBitmap(frame, 0)))
                } finally {
                    frame.recycle()
                }
            }
            return Output(expandLabels(labels.toList()), "", takenAt)
        } catch (error: ModelUnavailable) {
            throw error
        } catch (_: Throwable) {
            // Unsupported codec or a damaged file: name search still works.
            return Output("", "", null)
        } finally {
            try { retriever.release() } catch (_: Throwable) {}
        }
    }

    private fun frameAt(retriever: MediaMetadataRetriever, positionUs: Long): Bitmap? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            // Scaled in the decoder: no full-resolution frame is ever allocated.
            retriever.getScaledFrameAtTime(
                positionUs,
                MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                VIDEO_EDGE,
                VIDEO_EDGE,
            )
        } else {
            retriever.getFrameAtTime(positionUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        }

    /* ------------------------------------------------------------------ pdf */

    private fun analysePdf(file: File): String {
        val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        try {
            PdfRenderer(descriptor).use { renderer ->
                val parts = ArrayList<String>()
                for (index in 0 until minOf(renderer.pageCount, PDF_PAGES)) {
                    renderer.openPage(index).use { page ->
                        val width = TARGET_EDGE
                        val height = (width.toLong() * page.height / page.width.coerceAtLeast(1))
                            .toInt()
                            .coerceIn(1, TARGET_EDGE * 2)
                        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                        try {
                            bitmap.eraseColor(Color.WHITE)
                            page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                            parts.add(recognise(InputImage.fromBitmap(bitmap, 0)))
                        } finally {
                            bitmap.recycle()
                        }
                    }
                }
                return parts.joinToString("\n").take(MAX_TEXT)
            }
        } catch (error: ModelUnavailable) {
            throw error
        } catch (_: Throwable) {
            // Password-protected or malformed PDF.
            return ""
        } finally {
            try { descriptor.close() } catch (_: Throwable) {}
        }
    }

    /* ----------------------------------------------------------------- text */

    private fun readText(file: File): String {
        if (file.length() > MAX_TEXT_FILE_BYTES) return ""
        val buffer = ByteArray(TEXT_READ_BYTES)
        val read = FileInputStream(file).use { it.read(buffer) }
        if (read <= 0) return ""
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)
        return decoder.decode(java.nio.ByteBuffer.wrap(buffer, 0, read)).toString().take(MAX_TEXT)
    }

    /* --------------------------------------------------------------- models */

    private fun label(image: InputImage): List<String> = try {
        Tasks.await(labeler.process(image), MODEL_TIMEOUT_S, TimeUnit.SECONDS)
            .map { it.text.lowercase(Locale.ROOT) }
    } catch (error: Throwable) {
        throw unwrap(error)
    }

    private fun recognise(image: InputImage): String = try {
        Tasks.await(recognizer.process(image), MODEL_TIMEOUT_S, TimeUnit.SECONDS)
            .text
            .take(MAX_TEXT)
    } catch (error: Throwable) {
        throw unwrap(error)
    }

    /** Model-not-downloaded becomes ModelUnavailable, so the worker waits rather than failing files. */
    private fun unwrap(error: Throwable): Throwable {
        val cause = (error as? java.util.concurrent.ExecutionException)?.cause ?: error
        if (cause is MlKitException && cause.errorCode == MlKitException.UNAVAILABLE) {
            return ModelUnavailable(cause)
        }
        return cause
    }

    override fun close() {
        try { labeler.close() } catch (_: Throwable) {}
        try { recognizer.close() } catch (_: Throwable) {}
    }

    companion object {
        private const val TARGET_EDGE = 1280
        private const val VIDEO_EDGE = 640
        private const val PDF_PAGES = 3
        private const val LABEL_CONFIDENCE = 0.6f
        private const val MODEL_TIMEOUT_S = 30L
        private const val MAX_TEXT = 4000
        private const val TEXT_READ_BYTES = 64 * 1024
        private const val MAX_TEXT_FILE_BYTES = 5L * 1024 * 1024

        /** Labels that suggest a photo is worth reading for text. */
        private val TEXTY_LABELS = setOf(
            "poster", "paper", "menu", "receipt", "document", "text", "screenshot",
            "handwriting", "font", "comics", "newspaper", "book", "whiteboard", "sign",
            "banner", "flyer", "brochure", "ticket", "calendar", "monitor", "computer",
            "screen", "television", "website", "presentation", "chart", "map", "business card",
        )

        /** Paths that are almost always text: read them without asking the labeler. */
        private val TEXTY_PATH = Regex(
            "screenshot|screen_recording|scan|document|docs|whatsapp documents|receipt|invoice|bill|notes?|download",
            RegexOption.IGNORE_CASE,
        )

        fun looksTextual(path: String, name: String): Boolean =
            TEXTY_PATH.containsMatchIn(path) || name.endsWith(".png", ignoreCase = true)

        /** Words people type that ML Kit's label never says. Applied at index time, so queries stay simple. */
        private val SYNONYMS = mapOf(
            "dog" to "puppy pet", "cat" to "kitten pet", "bird" to "birds",
            "food" to "meal dish", "cake" to "dessert birthday", "dessert" to "sweet",
            "beach" to "sea ocean sand", "sky" to "clouds", "sunset" to "sunrise evening",
            "car" to "vehicle", "bicycle" to "bike cycle", "motorcycle" to "bike",
            "selfie" to "face portrait", "smile" to "happy face", "team" to "group people",
            "crowd" to "people", "flower" to "flowers plant", "plant" to "plants",
            "tree" to "trees nature", "mountain" to "mountains hills nature", "lake" to "water",
            "river" to "water", "pool" to "swimming water", "snow" to "winter",
            "christmas" to "xmas", "party" to "celebration", "bridge" to "architecture",
            "building" to "architecture", "receipt" to "bill invoice", "paper" to "document",
            "screenshot" to "screen", "baby" to "child kid", "child" to "kid kids",
        )

        fun expandLabels(labels: List<String>): String {
            val words = LinkedHashSet<String>()
            for (label in labels) {
                words.add(label)
                SYNONYMS[label]?.split(' ')?.let(words::addAll)
            }
            return words.joinToString(" ")
        }

        private fun parseExifDate(value: String): Long? = try {
            // EXIF has no zone; the camera's local time is the best guess.
            SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US).parse(value)?.time?.div(1000)
        } catch (_: Throwable) {
            null
        }

        private fun parseVideoDate(value: String): Long? = try {
            SimpleDateFormat("yyyyMMdd'T'HHmmss.SSS'Z'", Locale.US)
                .apply { timeZone = TimeZone.getTimeZone("UTC") }
                .parse(value)
                ?.time
                ?.div(1000)
                ?.takeIf { it > 0 }
        } catch (_: Throwable) {
            null
        }
    }
}

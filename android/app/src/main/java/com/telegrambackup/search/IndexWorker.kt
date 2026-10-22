package com.telegrambackup.search

import android.content.Context
import android.os.Build
import android.os.PowerManager
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.util.concurrent.TimeUnit

/**
 * Builds the search index in the background. No JS runtime is involved: the
 * whole pipeline (decode, models, SQLite) is native.
 *
 * Works in slices of [SLICE_MILLIS], under WorkManager's 10-minute limit for
 * non-foreground work, and returns retry() while anything is pending, so it
 * resumes after a short backoff for as long as its constraints hold (by
 * default: charging, battery not low). No foreground service or notification
 * is needed for that, and stopping is free: every result is already saved.
 */
class IndexWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val db = SearchDb.get(applicationContext)
        db.requeueOutdated()
        val deepOcr = inputData.getBoolean(KEY_DEEP_OCR, false)
        val deadline = System.currentTimeMillis() + SLICE_MILLIS
        // Rows already handed out this slice, so a failed one is not picked
        // again immediately while it still counts as pending.
        val seen = HashSet<Long>()
        val parallel = Semaphore(PARALLELISM)

        return try {
            Indexer(deepOcr).use { indexer ->
                while (!isStopped && System.currentTimeMillis() < deadline) {
                    if (tooHot()) {
                        Log.i(TAG, "Phone is warm; pausing indexing")
                        return Result.retry()
                    }
                    val batch = db.nextPending(BATCH, seen)
                    if (batch.isEmpty()) {
                        return Result.success()
                    }
                    batch.forEach { seen.add(it.id) }

                    val results = coroutineScope {
                        batch.map { item ->
                            async(Dispatchers.IO) {
                                parallel.withPermit { analyse(indexer, item) }
                            }
                        }.awaitAll()
                    }
                    db.saveResults(results)
                }
                if (db.stats().pending > 0) Result.retry() else Result.success()
            }
        } catch (error: Indexer.ModelUnavailable) {
            // Play services is still downloading the models. Nothing failed;
            // try again later.
            Log.i(TAG, "ML Kit models not available yet; will retry")
            Result.retry()
        }
    }

    private fun analyse(indexer: Indexer, item: SearchDb.Pending): SearchDb.Analysis =
        try {
            val output = indexer.analyse(item.path, item.name, item.kind)
            SearchDb.Analysis(item.id, output.labels, output.text, output.takenAt, failed = false)
        } catch (error: Indexer.ModelUnavailable) {
            throw error
        } catch (error: Throwable) {
            Log.w(TAG, "Could not index ${item.name}: ${error.message}")
            SearchDb.Analysis(item.id, "", "", null, failed = true)
        }

    private fun tooHot(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        val power = applicationContext.getSystemService(PowerManager::class.java) ?: return false
        return power.currentThermalStatus >= PowerManager.THERMAL_STATUS_MODERATE
    }

    companion object {
        private const val TAG = "SearchIndex"
        const val WORK_NAME = "telesync-search-index"
        private const val KEY_DEEP_OCR = "deepOcr"
        private const val SLICE_MILLIS = 8L * 60L * 1000L
        private const val BATCH = 16
        private const val PARALLELISM = 2

        /**
         * Queues the worker. `replace` restarts it with new settings (the user
         * tapped Index now); otherwise an already queued run is kept as is.
         */
        fun enqueue(context: Context, deepOcr: Boolean, chargingOnly: Boolean, replace: Boolean) {
            val constraints = Constraints.Builder()
                .setRequiresBatteryNotLow(true)
                .setRequiresCharging(chargingOnly)
                .build()
            val request = OneTimeWorkRequestBuilder<IndexWorker>()
                .setConstraints(constraints)
                .setInputData(workDataOf(KEY_DEEP_OCR to deepOcr))
                .setBackoffCriteria(BackoffPolicy.LINEAR, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_NAME,
                if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                request,
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}

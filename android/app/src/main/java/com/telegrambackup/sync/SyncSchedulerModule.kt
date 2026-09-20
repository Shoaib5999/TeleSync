package com.telegrambackup.sync

import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.util.concurrent.TimeUnit

/**
 * Schedules the periodic sync. The JS settings screen is the only caller.
 */
class SyncSchedulerModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    /**
     * (Re)registers the periodic job.
     *
     * Uses UPDATE so changing the interval in Settings takes effect without
     * losing the already-elapsed part of the current period.
     */
    @ReactMethod
    fun schedule(intervalHours: Double, wifiOnly: Boolean, requiresCharging: Boolean, promise: Promise) {
        try {
            // WorkManager clamps anything under 15 minutes; guard so an odd
            // setting cannot silently become a different interval.
            val hours = intervalHours.coerceAtLeast(0.25)

            val constraints = Constraints.Builder()
                .setRequiredNetworkType(if (wifiOnly) NetworkType.UNMETERED else NetworkType.CONNECTED)
                .setRequiresCharging(requiresCharging)
                .setRequiresBatteryNotLow(true)
                .build()

            val request = PeriodicWorkRequestBuilder<SyncWorker>(
                (hours * 60).toLong(),
                TimeUnit.MINUTES,
            )
                .setConstraints(constraints)
                .build()

            WorkManager.getInstance(reactContext).enqueueUniquePeriodicWork(
                SyncWorker.WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE,
                request,
            )
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_SCHEDULE", error.message, error)
        }
    }

    @ReactMethod
    fun cancel(promise: Promise) {
        try {
            WorkManager.getInstance(reactContext).cancelUniqueWork(SyncWorker.WORK_NAME)
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_CANCEL", error.message, error)
        }
    }

    /** "Run now" in HomeScreen: same worker, no constraints, once. */
    @ReactMethod
    fun runNow(promise: Promise) {
        try {
            val request = OneTimeWorkRequestBuilder<SyncWorker>().build()
            WorkManager.getInstance(reactContext).enqueue(request)
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_RUN_NOW", error.message, error)
        }
    }

    companion object {
        const val NAME = "SyncScheduler"
    }
}

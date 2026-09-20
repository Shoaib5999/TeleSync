package com.telegrambackup.sync

import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout

/**
 * The scheduled sync.
 *
 * Runs the JS engine through SyncHeadlessTaskService rather than reimplementing
 * anything: services/sync/engine.ts is the single source of truth for what a
 * sync does.
 *
 * The worker promotes itself to a foreground service first. That matters on
 * Android 12+, where an app in the background may not call
 * startForegroundService itself — WorkManager holds the exemption, so going
 * through setForeground() is the only reliable way to keep a long upload alive.
 */
class SyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val completion = SyncCoordinator.begin()

        return try {
            setForeground(buildForegroundInfo())

            // Plain startService is fine here: setForeground() has already put
            // the process in the foreground.
            applicationContext.startService(
                Intent(applicationContext, SyncHeadlessTaskService::class.java),
            )

            val success = withTimeout(MAX_RUN_MILLIS) { completion.await() }
            if (success) Result.success() else Result.retry()
        } catch (_: TimeoutCancellationException) {
            // The sync outlived the window. Anything already uploaded is
            // recorded in SQLite, so the next run picks up where this left off.
            SyncCoordinator.complete(false)
            Result.retry()
        } catch (error: Throwable) {
            SyncCoordinator.complete(false)
            // Most failures here are transient (no network, service start
            // refused); let WorkManager back off and try again.
            Result.retry()
        }
    }

    private fun buildForegroundInfo(): ForegroundInfo {
        val notification = SyncNotifications.build(
            context = applicationContext,
            title = "Backing up to Telegram",
            text = "Scheduled sync running…",
            progress = -1,
            max = 0,
            paused = false,
            // No Pause/Stop buttons: the user did not start this by hand, and a
            // half-paused scheduled job has nowhere to report back to.
            showActions = false,
        )

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(
                SyncNotifications.NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            ForegroundInfo(SyncNotifications.NOTIFICATION_ID, notification)
        }
    }

    companion object {
        const val WORK_NAME = "telegram-backup-periodic-sync"

        /**
         * WorkManager stops a worker after ~10 minutes, but a foreground worker
         * is exempt. We still bound it so a wedged run cannot block the next one
         * indefinitely.
         */
        private const val MAX_RUN_MILLIS = 6L * 60L * 60L * 1000L
    }
}

package com.telegrambackup.sync

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat

/**
 * Keeps the process alive while the user-initiated sync runs.
 *
 * The upload loop itself lives in JS (services/sync/engine.ts). This service
 * exists so Android does not kill the process once the screen goes off: as long
 * as a foreground service is running, the JS thread keeps executing.
 */
class SyncForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: "Backing up to Telegram"
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: "Preparing…"
        val progress = intent?.getIntExtra(EXTRA_PROGRESS, -1) ?: -1
        val max = intent?.getIntExtra(EXTRA_MAX, 0) ?: 0
        val paused = intent?.getBooleanExtra(EXTRA_PAUSED, false) ?: false

        val notification = SyncNotifications.build(
            context = this,
            title = title,
            text = text,
            progress = progress,
            max = max,
            paused = paused,
            showActions = true,
        )

        // Android 14 requires the type to be declared at startForeground time as
        // well as in the manifest, or it throws MissingForegroundServiceTypeException.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        } else {
            0
        }
        ServiceCompat.startForeground(this, SyncNotifications.NOTIFICATION_ID, notification, type)

        // Hold the CPU for the whole sync. Without this the JS loop is throttled
        // to a crawl once the screen goes off.
        SyncWakeLock.acquire(this)

        // START_STICKY would restart us with a null intent after a kill and show
        // a stale notification with no sync behind it; the JS side restarts
        // deliberately instead.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        // Released here rather than when the sync reports done, so an abnormal
        // teardown cannot leave the lock held.
        SyncWakeLock.release()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }

    companion object {
        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
        const val EXTRA_PROGRESS = "progress"
        const val EXTRA_MAX = "max"
        const val EXTRA_PAUSED = "paused"

        fun intent(
            context: Context,
            title: String,
            text: String,
            progress: Int,
            max: Int,
            paused: Boolean,
        ): Intent = Intent(context, SyncForegroundService::class.java).apply {
            putExtra(EXTRA_TITLE, title)
            putExtra(EXTRA_TEXT, text)
            putExtra(EXTRA_PROGRESS, progress)
            putExtra(EXTRA_MAX, max)
            putExtra(EXTRA_PAUSED, paused)
        }
    }
}

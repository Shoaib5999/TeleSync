package com.telegrambackup.sync

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.telegrambackup.MainActivity

/**
 * Shared notification plumbing for both sync entry points.
 *
 * The user-initiated foreground service and the scheduled WorkManager job show
 * the same notification, built here so they cannot drift apart.
 */
object SyncNotifications {

    const val CHANNEL_ID = "telegram_backup_sync"
    const val NOTIFICATION_ID = 4711

    const val ACTION_PAUSE = "com.telegrambackup.sync.PAUSE"
    const val ACTION_RESUME = "com.telegrambackup.sync.RESUME"
    const val ACTION_STOP = "com.telegrambackup.sync.STOP"

    const val REVIEW_CHANNEL_ID = "telegram_backup_review"
    const val REVIEW_NOTIFICATION_ID = 4712

    /**
     * Separate channel from the progress notification: this one is a prompt the
     * user needs to notice, so it may make a sound, whereas the progress
     * notification must stay silent while it ticks once per file.
     */
    fun ensureReviewChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(REVIEW_CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            REVIEW_CHANNEL_ID,
            "Deletion review",
            NotificationManager.IMPORTANCE_DEFAULT,
        ).apply {
            description = "Files that disappeared from a mirrored folder and need your decision"
        }
        manager.createNotificationChannel(channel)
    }

    /** Tells the user something is waiting; it never deletes anything itself. */
    fun buildReview(context: Context, count: Int): Notification {
        ensureReviewChannel(context)
        val text = if (count == 1) {
            "1 file was deleted from your phone. Review whether to remove the backup."
        } else {
            "$count files were deleted from your phone. Review whether to remove the backups."
        }
        return NotificationCompat.Builder(context, REVIEW_CHANNEL_ID)
            .setContentTitle("Deletions need review")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentIntent(contentIntent(context))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
    }

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Telegram backup",
            // LOW keeps the persistent progress notification silent: it updates
            // once per file and would otherwise buzz continuously.
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shows upload progress while backing up to Telegram"
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        }
        manager.createNotificationChannel(channel)
    }

    private fun actionIntent(context: Context, action: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, SyncActionReceiver::class.java).setAction(action)
        return PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun contentIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * @param progress current item, or -1 for an indeterminate bar while scanning
     * @param max total items
     * @param paused swaps the Pause action for Resume
     * @param showActions false for the scheduled job, which the user did not start by hand
     */
    fun build(
        context: Context,
        title: String,
        text: String,
        progress: Int,
        max: Int,
        paused: Boolean,
        showActions: Boolean,
    ): Notification {
        ensureChannel(context)

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentIntent(contentIntent(context))
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)

        if (max > 0) {
            builder.setProgress(max, progress.coerceAtLeast(0), false)
        } else {
            builder.setProgress(0, 0, true)
        }

        if (showActions) {
            if (paused) {
                builder.addAction(
                    android.R.drawable.ic_media_play,
                    "Resume",
                    actionIntent(context, ACTION_RESUME, 1),
                )
            } else {
                builder.addAction(
                    android.R.drawable.ic_media_pause,
                    "Pause",
                    actionIntent(context, ACTION_PAUSE, 2),
                )
            }
            builder.addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop",
                actionIntent(context, ACTION_STOP, 3),
            )
        }

        return builder.build()
    }
}

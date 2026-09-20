package com.telegrambackup.sync

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS control surface for the foreground service.
 *
 * JS owns the sync loop and tells this module what to display; the module never
 * decides progress on its own.
 */
class SyncControlModule(
    private val reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    /** Starts the service and shows the initial notification. */
    @ReactMethod
    fun startService(title: String, text: String, promise: Promise) {
        try {
            val intent = SyncForegroundService.intent(
                context = reactContext,
                title = title,
                text = text,
                progress = -1,
                max = 0,
                paused = false,
            )
            ContextCompat.startForegroundService(reactContext, intent)
            promise.resolve(true)
        } catch (error: Throwable) {
            // Android 12+ throws if we are not allowed to start a foreground
            // service from the background; surface it rather than failing mute.
            promise.reject("E_START_SERVICE", error.message, error)
        }
    }

    /**
     * Updates the existing notification in place.
     *
     * Posting to the same id is far cheaper than restarting the service, which
     * matters because this fires on every file.
     */
    @ReactMethod
    fun updateNotification(
        title: String,
        text: String,
        progress: Int,
        max: Int,
        paused: Boolean,
        promise: Promise,
    ) {
        try {
            val manager = reactContext.getSystemService(NotificationManager::class.java)
            if (manager == null) {
                promise.resolve(false)
                return
            }
            val notification = SyncNotifications.build(
                context = reactContext,
                title = title,
                text = text,
                progress = progress,
                max = max,
                paused = paused,
                showActions = true,
            )
            manager.notify(SyncNotifications.NOTIFICATION_ID, notification)
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_UPDATE_NOTIFICATION", error.message, error)
        }
    }

    @ReactMethod
    fun stopService(promise: Promise) {
        try {
            reactContext.stopService(Intent(reactContext, SyncForegroundService::class.java))
            reactContext
                .getSystemService(NotificationManager::class.java)
                ?.cancel(SyncNotifications.NOTIFICATION_ID)
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_STOP_SERVICE", error.message, error)
        }
    }

    /**
     * Whether the app can read files by absolute path outside the media
     * collections, which is what the Documents and Movies folders need.
     */
    @ReactMethod
    fun hasAllFilesAccess(promise: Promise) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            promise.resolve(Environment.isExternalStorageManager())
        } else {
            // Below Android 11, READ_EXTERNAL_STORAGE already covers this.
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun openAllFilesAccessSettings(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val intent = Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:${reactContext.packageName}"),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                reactContext.startActivity(intent)
            }
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_OPEN_SETTINGS", error.message, error)
        }
    }

    /**
     * Opens the battery-optimisation screen. Aggressive OEM battery managers are
     * the most common reason a long sync or a scheduled job silently stops.
     */
    @ReactMethod
    fun openBatteryOptimizationSettings(promise: Promise) {
        try {
            val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            reactContext.startActivity(intent)
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_OPEN_SETTINGS", error.message, error)
        }
    }

    /**
     * Runs the sync as a HeadlessJS task instead of on the UI JS context.
     *
     * This is not a nicety. React Native's JavaTimerManager stops pumping
     * setTimeout entirely once the activity pauses — TimerFrameCallback.doFrame
     * returns early when `isPaused && !isRunningTasks`, and clearFrameCallback
     * removes the choreographer callback altogether. A sync driven from the UI
     * context therefore stalls on every throttle/backoff sleep as soon as the
     * app goes to the background, even with a wake lock held.
     *
     * Starting a HeadlessJS task sets isRunningTasks = true, which keeps the
     * timer callback posted for the whole sync. The task runs in the same JS
     * runtime, so the engine singleton and its progress listeners are unaffected.
     */
    @ReactMethod
    fun startHeadlessSync(targetJson: String, manual: Boolean, promise: Promise) {
        try {
            val intent = Intent(reactContext, SyncHeadlessTaskService::class.java)
                .putExtra("targetJson", targetJson)
                .putExtra("manual", manual)
            reactContext.startService(intent)
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_START_HEADLESS", error.message, error)
        }
    }

    /**
     * Posts the "deletions need review" prompt. Called by JS after a sync that
     * detected missing files; it only informs, it never deletes.
     */
    @ReactMethod
    fun showDeletionReview(count: Int, promise: Promise) {
        try {
            val manager = reactContext.getSystemService(NotificationManager::class.java)
            if (manager == null || count <= 0) {
                promise.resolve(false)
                return
            }
            manager.notify(
                SyncNotifications.REVIEW_NOTIFICATION_ID,
                SyncNotifications.buildReview(reactContext, count),
            )
            promise.resolve(true)
        } catch (error: Throwable) {
            promise.reject("E_REVIEW_NOTIFICATION", error.message, error)
        }
    }

    /** Required so DeviceEventEmitter listeners register cleanly on the JS side. */
    @ReactMethod
    fun addListener(eventName: String) = Unit

    @ReactMethod
    fun removeListeners(count: Int) = Unit

    companion object {
        const val NAME = "SyncControl"
    }
}

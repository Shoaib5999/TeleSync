package com.telegrambackup.sync

import android.content.Context
import android.os.PowerManager
import android.util.Log

/**
 * Keeps the CPU awake for the duration of a sync.
 *
 * A foreground service only stops Android from killing the process — it does
 * NOT stop the CPU suspending once the screen goes off. Without this, the JS
 * upload loop and its setTimeout-based throttle get deferred and coalesced,
 * which measured at roughly 1.5 files/minute with the screen off versus ~19
 * with the app open.
 */
object SyncWakeLock {

    private const val TAG = "SyncWakeLock"
    private const val WAKE_LOCK_TAG = "TelegramBackup::Sync"

    /**
     * Safety net. A wake lock leaked by a crash would drain the battery until
     * reboot, so the system releases it for us after this long. Long enough for
     * a very large backlog on a slow connection.
     */
    private const val TIMEOUT_MS = 6L * 60L * 60L * 1000L

    private var wakeLock: PowerManager.WakeLock? = null

    @Synchronized
    fun acquire(context: Context) {
        if (wakeLock?.isHeld == true) return

        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
        if (power == null) {
            Log.w(TAG, "PowerManager unavailable; sync will be slow with the screen off")
            return
        }

        try {
            val lock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).apply {
                setReferenceCounted(false)
            }
            lock.acquire(TIMEOUT_MS)
            wakeLock = lock
            Log.i(TAG, "Wake lock acquired")
        } catch (error: Throwable) {
            // Never let this fail a sync; it only costs speed.
            Log.w(TAG, "Could not acquire wake lock", error)
        }
    }

    @Synchronized
    fun release() {
        val lock = wakeLock ?: return
        try {
            if (lock.isHeld) {
                lock.release()
                Log.i(TAG, "Wake lock released")
            }
        } catch (error: Throwable) {
            Log.w(TAG, "Could not release wake lock", error)
        } finally {
            wakeLock = null
        }
    }
}

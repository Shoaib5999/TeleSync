package com.telegrambackup.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * WorkManager normally restores its own jobs after a reboot. This receiver
 * exists so the app process is nudged awake on devices whose OEM battery
 * manager drops scheduled work, and so RECEIVE_BOOT_COMPLETED has a target.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != "android.intent.action.QUICKBOOT_POWERON"
        ) {
            return
        }
        // Re-enqueueing with KEEP would be wrong here: the stored settings live
        // in JS. WorkManager restores the existing periodic request itself, so
        // there is nothing to rebuild; touching the instance is enough to make
        // sure its scheduler is initialised after boot.
        androidx.work.WorkManager.getInstance(context.applicationContext)
    }
}

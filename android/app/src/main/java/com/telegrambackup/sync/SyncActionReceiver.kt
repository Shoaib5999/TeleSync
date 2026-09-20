package com.telegrambackup.sync

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Turns taps on the notification's Pause / Resume / Stop buttons into events
 * the JS sync engine listens for. The engine owns the loop, so the native side
 * only relays intent.
 */
class SyncActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            SyncNotifications.ACTION_PAUSE -> SyncBridge.emit(context, "pause")
            SyncNotifications.ACTION_RESUME -> SyncBridge.emit(context, "resume")
            SyncNotifications.ACTION_STOP -> SyncBridge.emit(context, "stop")
        }
    }
}

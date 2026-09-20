package com.telegrambackup.sync

import android.content.Context
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Thin native -> JS channel.
 *
 * Notification buttons arrive on a BroadcastReceiver with no React context of
 * their own, so we reach the live one through ReactHost and emit an event the
 * JS engine is subscribed to.
 */
object SyncBridge {

    private const val TAG = "SyncBridge"

    const val EVENT_NAME = "TelegramBackupSyncCommand"

    fun currentReactContext(context: Context): ReactContext? {
        val application = context.applicationContext as? ReactApplication ?: return null
        // ReactApplication.reactHost is nullable, and genuinely null before the
        // first React instance starts — a notification button can be tapped in
        // that window, so this has to degrade quietly rather than crash.
        return application.reactHost?.currentReactContext
    }

    fun emit(context: Context, command: String) {
        val reactContext = currentReactContext(context) ?: return

        // In bridgeless mode — the default on the New Architecture —
        // hasActiveReactInstance() can report false while the context is
        // perfectly usable, so checking it alone would silently drop every
        // notification button press. React Native's own ReactContext guards
        // with the same pair of conditions.
        if (!reactContext.hasActiveReactInstance() && !reactContext.isBridgeless) return

        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(EVENT_NAME, command)
        } catch (error: Throwable) {
            // The instance can be torn down between the check and the call;
            // a dropped Pause tap must not crash the receiver.
            Log.w(TAG, "Could not deliver sync command '" + command + "'", error)
        }
    }
}

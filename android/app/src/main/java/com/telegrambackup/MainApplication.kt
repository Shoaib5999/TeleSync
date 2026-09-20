package com.telegrambackup

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.telegrambackup.sync.SyncNotifications
import com.telegrambackup.sync.SyncPackage

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // SyncPackage is local to this app, so it is not autolinked.
          add(SyncPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
    // Register the channel up front: the headless worker can post a
    // notification before any UI has run.
    SyncNotifications.ensureChannel(this)
  }
}

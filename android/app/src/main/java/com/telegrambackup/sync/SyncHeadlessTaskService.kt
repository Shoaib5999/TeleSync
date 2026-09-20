package com.telegrambackup.sync

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Runs the JS sync task with no UI attached.
 *
 * Started by SyncWorker, which has already promoted itself to a foreground
 * service, so the process is alive and this can be a plain started service. The
 * JS side registers the matching task in index.js.
 */
class SyncHeadlessTaskService : HeadlessJsTaskService() {

    /** True when started by the Start Sync button rather than by SyncWorker. */
    private var isManual = false

    override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig {
        // Remember which kind of task this is: only a scheduled run may release
        // the WorkManager worker when it finishes.
        isManual = intent?.getBooleanExtra("manual", false) == true
        val data = intent?.extras?.let { Arguments.fromBundle(it) } ?: Arguments.createMap()
        return HeadlessJsTaskConfig(
            TASK_KEY,
            data,
            // A large backlog on a slow connection legitimately takes a long
            // time; the worker's own timeout is the real bound.
            TASK_TIMEOUT_MS,
            // Allowed in foreground so "Run now" behaves the same whether or not
            // the app happens to be open.
            true,
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // WorkManager already holds a wake lock while the worker runs, but the
        // JS task is what actually does the uploading — keep the CPU up
        // independently of WorkManager's internal lifecycle.
        SyncWakeLock.acquire(this)
        return super.onStartCommand(intent, flags, startId)
    }

    override fun onHeadlessJsTaskFinish(taskId: Int) {
        super.onHeadlessJsTaskFinish(taskId)
        // A manual sync has no worker waiting on it. Completing the coordinator
        // here would release a scheduled worker that is still mid-upload.
        if (!isManual) {
            SyncCoordinator.complete(true)
        }
    }

    override fun onDestroy() {
        SyncWakeLock.release()
        if (isManual) {
            isManual = false
            super.onDestroy()
            return
        }
        // If the service dies before the task reports back, release the worker
        // anyway so it cannot hang until its own timeout.
        if (SyncCoordinator.isPending()) {
            SyncCoordinator.complete(false)
        }
        super.onDestroy()
    }

    companion object {
        const val TASK_KEY = "TelegramBackupSync"
        private const val TASK_TIMEOUT_MS = 0L
    }
}

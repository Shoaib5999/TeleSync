package com.telegrambackup.sync

import kotlinx.coroutines.CompletableDeferred

/**
 * Handshake between SyncWorker and the headless JS task.
 *
 * The worker must stay alive for as long as JS is uploading, otherwise
 * WorkManager tears down its foreground notification mid-sync. The worker waits
 * on this deferred and the headless service completes it when the JS task
 * finishes.
 */
object SyncCoordinator {

    @Volatile
    private var pending: CompletableDeferred<Boolean>? = null

    /** Called by the worker before it starts the headless service. */
    fun begin(): CompletableDeferred<Boolean> {
        val deferred = CompletableDeferred<Boolean>()
        pending = deferred
        return deferred
    }

    /** Called by the headless service when the JS task settles. */
    fun complete(success: Boolean) {
        pending?.complete(success)
        pending = null
    }

    fun isPending(): Boolean = pending?.isActive == true
}

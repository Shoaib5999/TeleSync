import type { UploadJob } from '../../types';
import { logger } from '../../utils/logger';

/**
 * Sequential job queue for uploads.
 *
 * Deliberately serial: MTProto rate limits are per-account, so running uploads
 * in parallel just converts throughput into FLOOD_WAIT. Keeping one in flight
 * also means the progress notification maps to a single file, and a cancel
 * takes effect at a clean boundary.
 */

export interface QueueOutcome {
  uploaded: number;
  failed: number;
  /** True when the queue stopped early because it was cancelled. */
  cancelled: boolean;
}

export type JobResult = 'uploaded' | 'failed' | 'retry';

export interface QueueHandlers {
  /** Runs one job. Return 'retry' to put it back with a delay. */
  process: (job: UploadJob, attempt: number) => Promise<JobResult>;
  /** Called after every job, for progress reporting. */
  onProgress?: (done: number, total: number, job: UploadJob) => void;
}

/** How many times a single job may be re-queued before it is marked failed. */
const MAX_ATTEMPTS = 3;

export class UploadQueue {
  private jobs: UploadJob[];
  private readonly attempts = new Map<string, number>();

  constructor(jobs: UploadJob[]) {
    this.jobs = [...jobs];
  }

  get size(): number {
    return this.jobs.length;
  }

  async run(
    handlers: QueueHandlers,
    signal: AbortSignal,
  ): Promise<QueueOutcome> {
    const total = this.jobs.length;
    let uploaded = 0;
    let failed = 0;
    let done = 0;

    while (this.jobs.length > 0) {
      if (signal.aborted) {
        logger.info(
          'queue',
          `Cancelled with ${this.jobs.length} job(s) still queued`,
        );
        return { uploaded, failed, cancelled: true };
      }

      const job = this.jobs.shift() as UploadJob;
      const attempt = (this.attempts.get(job.localPath) ?? 0) + 1;
      this.attempts.set(job.localPath, attempt);

      let result: JobResult;
      try {
        result = await handlers.process(job, attempt);
      } catch (error) {
        if (signal.aborted) {
          return { uploaded, failed, cancelled: true };
        }
        // process() is expected to classify its own errors; anything escaping
        // is treated as a retryable fault so one bad file cannot end the run.
        logger.error('queue', `Unhandled error on ${job.fileName}`, error);
        result = 'retry';
      }

      if (result === 'retry' && attempt < MAX_ATTEMPTS) {
        // Back of the queue: let other files through before trying again.
        this.jobs.push(job);
        continue;
      }

      if (result === 'uploaded') {
        uploaded += 1;
      } else {
        failed += 1;
        if (result === 'retry') {
          logger.warn(
            'queue',
            `Giving up on ${job.fileName} after ${attempt} attempts`,
          );
        }
      }

      done += 1;
      handlers.onProgress?.(done, total, job);
    }

    return { uploaded, failed, cancelled: false };
  }
}

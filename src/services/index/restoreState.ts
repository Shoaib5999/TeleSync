import { configRepo } from '../db/schema';

/** Whether this install restored its index, declined to, or had none to restore. */
const STATE_KEY = 'index_restore_state';

/** 'done' = restored, 'declined' = user chose to start over, 'none' = nothing to restore. */
export type RestoreState = 'done' | 'declined' | 'none';

export async function getRestoreState(): Promise<RestoreState | null> {
  const value = await configRepo.getValue(STATE_KEY);
  return value === 'done' || value === 'declined' || value === 'none'
    ? value
    : null;
}

export async function setRestoreState(state: RestoreState): Promise<void> {
  await configRepo.setValue(STATE_KEY, state);
}

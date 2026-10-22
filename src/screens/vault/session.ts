import { create } from 'zustand';

import { clearVaultCache } from '../../services/telegram/browse';

/**
 * Whether the Vault is unlocked right now. Kept outside the screen so it
 * survives switching tabs, and is decided by the auto-lock rules instead.
 */
interface VaultSession {
  unlocked: boolean;
  /** Unix ms when the user last left the Vault tab or the app. */
  leftAt: number | null;
  /**
   * Set just before a system prompt or another app takes the screen on
   * purpose (fingerprint enrolment, "Open with"), so that one departure does
   * not count as leaving.
   */
  ignoreNextLeave: boolean;
  expectLeave: () => void;
  unlock: () => void;
  /** Locks and wipes every decrypted file. */
  lock: () => Promise<void>;
  markLeft: () => void;
  /** Locks if the user was away longer than `autoLockSeconds`. */
  checkReturn: (autoLockSeconds: number) => Promise<void>;
}

export const useVaultSession = create<VaultSession>((set, get) => ({
  unlocked: false,
  leftAt: null,
  ignoreNextLeave: false,

  expectLeave() {
    set({ ignoreNextLeave: true });
  },

  unlock() {
    set({ unlocked: true, leftAt: null });
  },

  async lock() {
    set({ unlocked: false, leftAt: null, ignoreNextLeave: false });
    await clearVaultCache();
  },

  markLeft() {
    if (get().ignoreNextLeave) {
      set({ ignoreNextLeave: false });
      return;
    }
    if (get().unlocked && get().leftAt === null) {
      set({ leftAt: Date.now() });
    }
  },

  async checkReturn(autoLockSeconds) {
    const { unlocked, leftAt } = get();
    if (!unlocked || leftAt === null) {
      return;
    }
    if (Date.now() - leftAt >= autoLockSeconds * 1000) {
      await get().lock();
    } else {
      set({ leftAt: null });
    }
  },
}));

export const AUTO_LOCK_CHOICES: { label: string; seconds: number }[] = [
  { label: 'Immediately', seconds: 0 },
  { label: '1 minute', seconds: 60 },
  { label: '5 minutes', seconds: 300 },
  { label: '15 minutes', seconds: 900 },
];

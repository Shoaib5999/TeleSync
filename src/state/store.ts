import { create } from 'zustand';

import { configRepo, topicsRepo } from '../services/db/schema';
import { secureStore } from '../services/secure/keychain';
import { getAuthState, getChannelTitle } from '../services/telegram/client';
import { getCounts, syncEngine } from '../services/sync/engine';
import { scheduleSync } from '../background/scheduler';
import { logger, describeError } from '../utils/logger';
import {
  DEFAULT_CONFIG,
  INITIAL_PROGRESS,
  type AppConfig,
  type RemoteTopic,
  type SyncProgress,
  type TelegramAuthState,
  type TopicRecord,
} from '../types';

interface Counts {
  uploaded: number;
  failed: number;
  pending: number;
}

interface AppState {
  ready: boolean;
  config: AppConfig;
  auth: TelegramAuthState;
  progress: SyncProgress;
  counts: Counts;
  topics: TopicRecord[];
  remoteTopics: RemoteTopic[];
  topicsLoading: boolean;
  channelTitle: string | null;

  initialise: () => Promise<void>;
  saveConfig: (patch: Partial<AppConfig>) => Promise<void>;
  refreshAuth: () => Promise<void>;
  refreshChannel: () => Promise<void>;
  refreshCounts: () => Promise<void>;
  refreshTopics: () => Promise<void>;
  setRemoteTopics: (topics: RemoteTopic[]) => void;
  setTopicsLoading: (loading: boolean) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  ready: false,
  config: { ...DEFAULT_CONFIG },
  auth: { loggedIn: false, userId: null, displayName: null, phone: null },
  progress: { ...INITIAL_PROGRESS },
  counts: { uploaded: 0, failed: 0, pending: 0 },
  topics: [],
  remoteTopics: [],
  topicsLoading: false,
  channelTitle: null,

  async initialise() {
    try {
      const config = await configRepo.load();
      // api_hash lives in the Keychain, so merge it back in for display.
      const apiHash = (await secureStore.getApiHash()) ?? '';

      set({ config: { ...config, apiHash } });

      // Mirror engine progress into the store so any screen can render it.
      syncEngine.subscribe(progress => set({ progress }));

      await get().refreshTopics();
      await get().refreshCounts();
      await get().refreshAuth();
      await get().refreshChannel();

      set({ ready: true });
    } catch (error) {
      logger.error('store', 'Initialisation failed', error);
      set({ ready: true });
    }
  },

  async saveConfig(patch) {
    const next = { ...get().config, ...patch };
    set({ config: next });

    try {
      if (patch.apiHash !== undefined && patch.apiHash.length > 0) {
        await secureStore.setApiHash(patch.apiHash);
      }
      await configRepo.save(next);

      // Interval or constraint changes must reach WorkManager immediately,
      // otherwise the old schedule keeps running until the next app start.
      if (
        patch.syncIntervalHours !== undefined ||
        patch.wifiOnly !== undefined ||
        patch.requiresCharging !== undefined
      ) {
        await scheduleSync().catch(error =>
          logger.warn('store', `Could not reschedule: ${describeError(error)}`),
        );
      }
    } catch (error) {
      logger.error('store', 'Could not save settings', error);
      throw error;
    }
  },

  async refreshAuth() {
    const auth = await getAuthState();
    set({ auth });
  },

  async refreshChannel() {
    set({ channelTitle: await getChannelTitle() });
  },

  async refreshCounts() {
    try {
      set({ counts: await getCounts() });
    } catch (error) {
      logger.warn('store', `Could not read counts: ${describeError(error)}`);
    }
  },

  async refreshTopics() {
    try {
      set({ topics: await topicsRepo.all() });
    } catch (error) {
      logger.warn('store', `Could not read topics: ${describeError(error)}`);
    }
  },

  setRemoteTopics(remoteTopics) {
    set({ remoteTopics });
  },

  setTopicsLoading(topicsLoading) {
    set({ topicsLoading });
  },
}));

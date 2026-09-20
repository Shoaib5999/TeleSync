import { createMMKV } from 'react-native-mmkv';
import type { LogEntry, LogLevel } from '../types';

/**
 * Rotating in-app log, capped at MAX_ENTRIES.
 *
 * Backed by MMKV rather than SQLite so the foreground service and the headless
 * WorkManager task can both append without holding a DB transaction, and so a
 * crash mid-upload still leaves the tail readable in LogsScreen.
 */
const MAX_ENTRIES = 1000;
const STORAGE_KEY = 'logs.v1';

const storage = createMMKV({ id: 'telegram-backup-logs' });

type Listener = (entries: LogEntry[]) => void;

let cache: LogEntry[] | null = null;
const listeners = new Set<Listener>();

function load(): LogEntry[] {
  if (cache) {
    return cache;
  }
  try {
    const raw = storage.getString(STORAGE_KEY);
    cache = raw ? (JSON.parse(raw) as LogEntry[]) : [];
  } catch {
    // A corrupt log must never break the app; start fresh.
    cache = [];
  }
  return cache;
}

function persist(entries: LogEntry[]): void {
  cache = entries;
  try {
    storage.set(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Out of space or serialisation failure: drop the write, keep running.
  }
  listeners.forEach(listener => listener(entries));
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

function append(level: LogLevel, scope: string, message: string): void {
  const entry: LogEntry = {
    id: nextId(),
    ts: Date.now(),
    level,
    scope,
    message,
  };
  const entries = load();
  // Newest first, so LogsScreen renders without reversing.
  const next = [entry, ...entries];
  if (next.length > MAX_ENTRIES) {
    next.length = MAX_ENTRIES;
  }
  persist(next);

  if (__DEV__) {
    const line = `[${scope}] ${message}`;
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
}

/** Turns anything thrown into a readable one-line message. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export const logger = {
  info(scope: string, message: string): void {
    append('info', scope, message);
  },
  warn(scope: string, message: string): void {
    append('warn', scope, message);
  },
  error(scope: string, message: string, error?: unknown): void {
    append(
      'error',
      scope,
      error ? `${message}: ${describeError(error)}` : message,
    );
  },
  all(): LogEntry[] {
    return load();
  },
  clear(): void {
    persist([]);
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};

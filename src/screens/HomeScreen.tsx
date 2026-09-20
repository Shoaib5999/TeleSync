import React, { useCallback, useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import {
  Button,
  Card,
  Checkbox,
  Divider,
  ProgressBar,
  Snackbar,
  Text,
  TouchableRipple,
} from 'react-native-paper';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';

import { useAppStore } from '../state/store';
import {
  attachNotificationCommands,
  cancelSync,
  hasAllFilesAccess,
  openAllFilesAccessSettings,
  openBatteryOptimizationSettings,
  pauseSync,
  resumeSync,
  startForegroundSync,
} from '../background/foreground';
import { runSyncNow } from '../background/scheduler';
import {
  listSyncSources,
  syncEngine,
  targetFromSources,
} from '../services/sync/engine';
import { describeError } from '../utils/logger';
import type { SyncSource } from '../types';
import type { RootTabParamList } from '../navigation';

function relativeTime(timestamp: number | null): string {
  if (!timestamp) {
    return 'never';
  }
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** Trims a long path to something readable in a list row. */
function shortPath(path: string): string {
  return path.replace('/storage/emulated/0/', '');
}

export default function HomeScreen(): React.JSX.Element {
  const navigation = useNavigation<BottomTabNavigationProp<RootTabParamList>>();
  const {
    auth,
    config,
    progress,
    counts,
    channelTitle,
    refreshCounts,
    refreshAuth,
    refreshChannel,
  } = useAppStore();

  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [allFiles, setAllFiles] = useState(true);
  const [sources, setSources] = useState<SyncSource[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // The notification's Pause/Stop buttons stay wired for the app's lifetime.
  useEffect(() => attachNotificationCommands(), []);

  useEffect(() => {
    void hasAllFilesAccess().then(setAllFiles);
  }, []);

  /**
   * Reloads the backup sources from the current bindings.
   *
   * Selection is reconciled rather than reset: a folder unbound on the Folders
   * tab disappears from the list and from the selection, so "Start Sync" can
   * never run against a binding that no longer exists.
   */
  const reloadSources = useCallback(async () => {
    const next = await listSyncSources(config);
    setSources(next);
    setSelected(previous => {
      const validIds = new Set(next.map(source => source.id));
      const kept = new Set([...previous].filter(id => validIds.has(id)));
      // First load, or every previous choice vanished: select everything, so
      // the common case needs no tapping.
      if (kept.size === 0) {
        return validIds;
      }
      return kept;
    });
  }, [config]);

  // Re-read on every focus, so returning from the Folders tab always shows the
  // current bindings instead of a stale snapshot.
  useFocusEffect(
    useCallback(() => {
      void reloadSources();
      void refreshCounts();
    }, [reloadSources, refreshCounts]),
  );

  useEffect(() => {
    if (progress.phase === 'done' || progress.phase === 'cancelled') {
      void refreshCounts();
    }
  }, [progress.phase, refreshCounts]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      refreshCounts(),
      refreshAuth(),
      refreshChannel(),
      reloadSources(),
    ]);
    setRefreshing(false);
  }, [refreshCounts, refreshAuth, refreshChannel, reloadSources]);

  const toggle = useCallback((id: string) => {
    setSelected(previous => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectedSources = sources.filter(source => selected.has(source.id));

  const onStart = useCallback(async () => {
    if (selectedSources.length === 0) {
      setMessage('Pick at least one folder to back up.');
      return;
    }
    try {
      await startForegroundSync(targetFromSources(selectedSources));
    } catch (error) {
      setMessage(describeError(error));
    }
  }, [selectedSources]);

  const onRunNow = useCallback(async () => {
    try {
      await runSyncNow();
      setMessage('Scheduled sync queued. It runs everything you have bound.');
    } catch (error) {
      setMessage(describeError(error));
    }
  }, []);

  const running =
    progress.phase === 'scanning' || progress.phase === 'uploading';
  const paused = progress.phase === 'paused';
  const busy = running || paused;
  const fraction = progress.total > 0 ? progress.processed / progress.total : 0;
  const nothingConfigured = sources.length === 0;

  return (
    <>
      <ScrollView
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        <Card mode="outlined" style={styles.card}>
          <Card.Title title="Connection" />
          <Card.Content>
            <Text variant="bodyMedium">
              {auth.loggedIn
                ? `Signed in as ${auth.displayName}`
                : 'Not signed in'}
            </Text>
            <Text variant="bodySmall" style={styles.dim}>
              Channel: {channelTitle ?? config.channelId ?? 'not set'}
              {channelTitle ? ` (${config.channelId})` : ''}
            </Text>
            <Text variant="bodySmall" style={styles.dim}>
              Last synced {relativeTime(progress.lastSyncAt)}
            </Text>
          </Card.Content>
        </Card>

        {!allFiles && (
          <Card mode="outlined" style={styles.card}>
            <Card.Title title="All files access needed" />
            <Card.Content>
              <Text variant="bodySmall">
                Without it, folders MediaStore does not index — Documents,
                Movies, and custom folders — will scan as empty.
              </Text>
            </Card.Content>
            <Card.Actions>
              <Button
                onPress={() => {
                  void openAllFilesAccessSettings();
                }}
              >
                Grant access
              </Button>
            </Card.Actions>
          </Card>
        )}

        {/* What a sync will actually touch. Nothing outside this list is read. */}
        <Card mode="outlined" style={styles.card}>
          <Card.Title
            title="What to back up"
            subtitle={
              nothingConfigured
                ? 'Nothing configured yet'
                : `${selectedSources.length} of ${sources.length} selected`
            }
          />
          <Card.Content>
            {nothingConfigured ? (
              <Text variant="bodySmall" style={styles.dim}>
                Bind a folder to a topic on the Folders tab and it will appear
                here. Only folders listed here are ever read.
              </Text>
            ) : (
              sources.map(source => (
                <TouchableRipple
                  key={source.id}
                  onPress={() => toggle(source.id)}
                  disabled={busy}
                  style={styles.sourceRow}
                >
                  <View style={styles.sourceInner}>
                    <Checkbox
                      status={selected.has(source.id) ? 'checked' : 'unchecked'}
                      onPress={() => toggle(source.id)}
                      disabled={busy}
                    />
                    <View style={styles.sourceText}>
                      <Text variant="bodyMedium" numberOfLines={1}>
                        {source.kind === 'all-media'
                          ? source.label
                          : shortPath(source.label)}
                      </Text>
                      <Text variant="bodySmall" style={styles.sourceTopic}>
                        → {source.topicTitle}
                      </Text>
                    </View>
                  </View>
                </TouchableRipple>
              ))
            )}
          </Card.Content>
          {!nothingConfigured && (
            <Card.Actions style={styles.actions}>
              <Button
                disabled={busy}
                onPress={() =>
                  setSelected(new Set(sources.map(source => source.id)))
                }
              >
                Select all
              </Button>
              <Button disabled={busy} onPress={() => setSelected(new Set())}>
                Clear
              </Button>
            </Card.Actions>
          )}
          {nothingConfigured && (
            <Card.Actions>
              <Button
                mode="contained"
                icon="folder-plus"
                onPress={() => navigation.navigate('Folders')}
              >
                Add a folder
              </Button>
            </Card.Actions>
          )}
        </Card>

        <Card mode="outlined" style={styles.card}>
          <Card.Title title="Sync" />
          <Card.Content>
            {busy && (
              <>
                <ProgressBar
                  progress={progress.phase === 'scanning' ? 0 : fraction}
                  indeterminate={progress.phase === 'scanning'}
                  style={styles.progress}
                />
                <Text variant="bodySmall" style={styles.dim}>
                  {progress.phase === 'scanning'
                    ? 'Scanning for new files…'
                    : `${progress.processed} of ${progress.total} — ${
                        progress.currentFileName ?? ''
                      }`}
                </Text>
              </>
            )}

            {progress.phase === 'error' && progress.errorMessage && (
              <Text variant="bodySmall" style={styles.error}>
                {progress.errorMessage}
              </Text>
            )}

            <Divider style={styles.divider} />

            <View style={styles.statsRow}>
              <Stat label="Uploaded" value={counts.uploaded} />
              <Stat label="Failed" value={counts.failed} />
              <Stat label="Pending" value={counts.pending} />
            </View>
          </Card.Content>

          <Card.Actions style={styles.actions}>
            {!busy && (
              <Button
                mode="contained"
                onPress={onStart}
                disabled={!auth.loggedIn || selectedSources.length === 0}
              >
                {selectedSources.length === sources.length
                  ? 'Start Sync'
                  : `Sync ${selectedSources.length} selected`}
              </Button>
            )}
            {running && (
              <Button mode="contained-tonal" onPress={pauseSync}>
                Pause
              </Button>
            )}
            {paused && (
              <Button mode="contained" onPress={resumeSync}>
                Resume
              </Button>
            )}
            {busy && (
              <Button mode="outlined" onPress={cancelSync}>
                Stop
              </Button>
            )}
          </Card.Actions>
          {!busy && auth.loggedIn && selectedSources.length === 0 && (
            <Card.Content>
              <Text variant="bodySmall" style={styles.dim}>
                {nothingConfigured
                  ? 'Add a folder above to enable syncing.'
                  : 'Select at least one folder above.'}
              </Text>
            </Card.Content>
          )}
        </Card>

        <Card mode="outlined" style={styles.card}>
          <Card.Title
            title="Scheduled sync"
            subtitle={`Every ${config.syncIntervalHours} hours`}
          />
          <Card.Content>
            <Text variant="bodySmall" style={styles.dim}>
              {config.wifiOnly ? 'Wi-Fi only' : 'Any network'}
              {config.requiresCharging ? ', while charging' : ''}
            </Text>
            <Text variant="bodySmall" style={styles.dim}>
              Runs every bound folder, not just the selection above.
            </Text>
          </Card.Content>
          <Card.Actions>
            <Button
              onPress={onRunNow}
              disabled={!auth.loggedIn || syncEngine.isRunning}
            >
              Run now
            </Button>
            <Button
              onPress={() => {
                void openBatteryOptimizationSettings();
              }}
            >
              Battery settings
            </Button>
          </Card.Actions>
        </Card>
      </ScrollView>

      <Snackbar
        visible={message !== null}
        onDismiss={() => setMessage(null)}
        duration={5000}
      >
        {message ?? ''}
      </Snackbar>
    </>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.JSX.Element {
  return (
    <View style={styles.stat}>
      <Text variant="headlineSmall">{value}</Text>
      <Text variant="bodySmall" style={styles.dim}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 32 },
  card: { marginBottom: 16 },
  dim: { opacity: 0.7, marginTop: 4 },
  error: { color: '#B3261E', marginTop: 8 },
  progress: { height: 6, borderRadius: 3, marginBottom: 8 },
  divider: { marginVertical: 12 },
  statsRow: { flexDirection: 'row', justifyContent: 'space-around' },
  stat: { alignItems: 'center' },
  actions: { justifyContent: 'flex-start', paddingHorizontal: 8, gap: 8 },
  sourceRow: { marginHorizontal: -8, borderRadius: 8 },
  sourceInner: { flexDirection: 'row', alignItems: 'center', paddingRight: 8 },
  sourceText: { flex: 1, paddingLeft: 4 },
  sourceTopic: { opacity: 0.7 },
});

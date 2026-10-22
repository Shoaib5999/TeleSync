import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  Button,
  Dialog,
  Portal,
  ProgressBar,
  Searchbar,
  Switch,
  Text,
} from 'react-native-paper';

import {
  feedSearchIndex,
  getSearchStats,
  loadSearchSettings,
  saveSearchSetting,
  searchBackup,
  startIndexing,
  type SearchResult,
  type SearchSettings,
} from '../../services/search/feeder';
import {
  searchAvailable,
  type SearchStats,
} from '../../services/search/native';
import { useVaultSession } from '../vault/session';
import { describeError } from '../../utils/logger';

/** Debounce for typing; the native query itself takes a few milliseconds. */
const QUERY_DELAY_MS = 180;
const STATS_POLL_MS = 4000;

/**
 * Search bar for the Restore tab. Searches file names, folders, dates,
 * what is in photos, and text read from photos, screenshots and PDFs,
 * all on the device.
 *
 * Reports results upward (null = not searching) so the list below can show
 * them with its existing preview and restore actions.
 */
export default function SmartSearchHeader({
  onResults,
  onMessage,
}: {
  onResults: (results: SearchResult[] | null) => void;
  onMessage: (message: string) => void;
}): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [stats, setStats] = useState<SearchStats | null>(null);
  const [settings, setSettings] = useState<SearchSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const vaultUnlocked = useVaultSession(state => state.unlocked);
  const requestId = useRef(0);
  const available = searchAvailable();

  const refreshStats = useCallback(async () => {
    try {
      setStats(await getSearchStats());
    } catch {
      // Stats are decoration; a failed read must not disturb searching.
    }
  }, []);

  // Catch up on anything synced since the tab was last open, then show progress.
  useFocusEffect(
    useCallback(() => {
      if (!available) {
        return undefined;
      }
      void loadSearchSettings().then(setSettings);
      void feedSearchIndex()
        .catch(error => onMessage(describeError(error)))
        .finally(refreshStats);
      const timer = setInterval(() => {
        void refreshStats();
      }, STATS_POLL_MS);
      return () => clearInterval(timer);
    }, [available, onMessage, refreshStats]),
  );

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      onResults(null);
      setSearching(false);
      return undefined;
    }
    const id = ++requestId.current;
    setSearching(true);
    const timer = setTimeout(() => {
      const includeEncrypted =
        vaultUnlocked && (settings?.includeEncrypted ?? false);
      searchBackup(trimmed, includeEncrypted)
        .then(results => {
          // Drop answers to queries the user has already typed past.
          if (id === requestId.current) {
            onResults(results);
          }
        })
        .catch(error => onMessage(describeError(error)))
        .finally(() => {
          if (id === requestId.current) {
            setSearching(false);
          }
        });
    }, QUERY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, vaultUnlocked, settings, onResults, onMessage]);

  const onToggle = useCallback(
    async (key: keyof SearchSettings, value: boolean) => {
      try {
        await saveSearchSetting(key, value);
        setSettings(await loadSearchSettings());
        await refreshStats();
      } catch (error) {
        onMessage(describeError(error));
      }
    },
    [onMessage, refreshStats],
  );

  if (!available) {
    return null;
  }

  const analysed = stats ? stats.done + stats.failed : 0;
  const indexing = stats !== null && stats.pending > 0;

  return (
    <View style={styles.container}>
      <Searchbar
        placeholder="Search names, places, things, text in photos…"
        value={query}
        onChangeText={setQuery}
        loading={searching}
        style={styles.bar}
      />
      {stats && stats.total > 0 && (
        <View style={styles.statusRow}>
          <View style={styles.statusText}>
            <Text variant="bodySmall" style={styles.dim}>
              {indexing
                ? `Smart search: ${analysed} of ${stats.total} analysed${settings?.chargingOnly ? ' · continues while charging' : ''}`
                : `Smart search ready · ${stats.total} files`}
            </Text>
            {indexing && (
              <ProgressBar
                progress={stats.total > 0 ? analysed / stats.total : 0}
                style={styles.progress}
              />
            )}
          </View>
          <Button compact onPress={() => setSettingsOpen(true)}>
            Options
          </Button>
        </View>
      )}

      <Portal>
        <Dialog visible={settingsOpen} onDismiss={() => setSettingsOpen(false)}>
          <Dialog.Title>Smart search</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodySmall" style={styles.dim}>
              Runs entirely on this phone. What it learns is never uploaded.
            </Text>
            <SettingRow
              title="Only while charging"
              detail="Builds the index in the background while plugged in."
              value={settings?.chargingOnly ?? true}
              onChange={value => {
                void onToggle('chargingOnly', value);
              }}
            />
            <SettingRow
              title="Read text in every photo"
              detail="Slower. Off: text is read from screenshots, documents and photos that look like they contain text."
              value={settings?.deepOcr ?? false}
              onChange={value => {
                void onToggle('deepOcr', value);
              }}
            />
            <SettingRow
              title="Include encrypted folders"
              detail="Analyses them too. Their results only appear while the Vault is unlocked."
              value={settings?.includeEncrypted ?? false}
              onChange={value => {
                void onToggle('includeEncrypted', value);
              }}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button
              onPress={() => {
                void startIndexing(true)
                  .then(() => onMessage('Indexing started'))
                  .catch(error => onMessage(describeError(error)));
                setSettingsOpen(false);
              }}
            >
              Index now
            </Button>
            <Button onPress={() => setSettingsOpen(false)}>Done</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </View>
  );
}

function SettingRow({
  title,
  detail,
  value,
  onChange,
}: {
  title: string;
  detail: string;
  value: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingLabel}>
        <Text variant="bodyMedium">{title}</Text>
        <Text variant="bodySmall" style={styles.dim}>
          {detail}
        </Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginBottom: 12 },
  bar: { marginBottom: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusText: { flex: 1, paddingLeft: 4 },
  dim: { opacity: 0.7 },
  progress: { height: 4, borderRadius: 2, marginTop: 4 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  settingLabel: { flex: 1, paddingRight: 12 },
});

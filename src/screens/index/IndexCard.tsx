import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  Portal,
  ProgressBar,
  Text,
  TextInput,
} from 'react-native-paper';

import { useAppStore } from '../../state/store';
import { filesRepo } from '../../services/db/schema';
import {
  listPublishedSnapshots,
  pendingSinceSnapshot,
  publishSnapshot,
  type SnapshotInfo,
} from '../../services/index/publish';
import {
  RestorePassphraseNeeded,
  adoptByNameAndSize,
  declineRestore,
  restoreIndex,
  type RestoreStage,
} from '../../services/index/restore';
import { getRestoreState, type RestoreState } from '../../services/index/guard';
import { syncEngine } from '../../services/sync/engine';
import { describeError } from '../../utils/logger';
import type { AppConfig } from '../../types';

const STAGE_LABEL: Record<RestoreStage, string> = {
  snapshot: 'Downloading the index snapshot…',
  tags: 'Reading uploads newer than the snapshot…',
  verify: 'Checking each backed-up message still exists…',
  write: 'Writing the index…',
  scan: 'Scanning your folders…',
  channel: 'Reading the whole channel…',
};

function formatDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString();
}

/**
 * Settings card for the self-describing backup index: shows when it was last
 * snapshotted, publishes on demand, and restores it on a new install.
 */
export default function IndexCard({
  onMessage,
  onSettingsRestored,
}: {
  onMessage: (message: string) => void;
  /** Called after restored settings were saved, so drafts can refresh. */
  onSettingsRestored: (config: AppConfig) => void;
}): React.JSX.Element {
  const { saveConfig, refreshCounts, refreshTopics } = useAppStore();
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([]);
  const [pending, setPending] = useState(0);
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [state, setState] = useState<RestoreState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState<{
    stage: RestoreStage;
    done: number;
    total: number;
  } | null>(null);
  const [restoreSettings, setRestoreSettings] = useState(true);
  const [askPassphrase, setAskPassphrase] = useState<{ wrong: boolean } | null>(
    null,
  );
  const [passphrase, setPassphrase] = useState('');
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [confirmAdopt, setConfirmAdopt] = useState(false);

  const load = useCallback(async () => {
    const [list, newer, count, restoreState] = await Promise.all([
      listPublishedSnapshots(),
      pendingSinceSnapshot(),
      filesRepo.count(),
      getRestoreState(),
    ]);
    setSnapshots(list);
    setPending(newer);
    setFileCount(count);
    setState(restoreState);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const guardBusy = useCallback((): boolean => {
    if (syncEngine.isRunning) {
      onMessage('Wait for the current sync to finish first.');
      return true;
    }
    return false;
  }, [onMessage]);

  const onPublish = useCallback(async () => {
    if (guardBusy()) {
      return;
    }
    setBusy('publish');
    try {
      const info = await publishSnapshot();
      onMessage(
        info
          ? `Index snapshot saved to Telegram (${info.files} files)`
          : 'Nothing backed up yet, so there is no index to save.',
      );
      await load();
    } catch (error) {
      onMessage(describeError(error));
    } finally {
      setBusy(null);
    }
  }, [guardBusy, load, onMessage]);

  const onRestore = useCallback(
    async (options: { passphrase?: string; skipEncrypted?: boolean } = {}) => {
      if (guardBusy()) {
        return;
      }
      setBusy('restore');
      setStage(null);
      try {
        const report = await restoreIndex({
          ...options,
          onProgress: (s, done, total) => setStage({ stage: s, done, total }),
        });
        if (restoreSettings && report.settings) {
          await saveConfig(report.settings);
          onSettingsRestored(useAppStore.getState().config);
        }
        await refreshTopics();
        await refreshCounts();
        const parts = [
          `Restored ${report.restored} file record${report.restored === 1 ? '' : 's'}`,
        ];
        if (report.missing > 0) {
          parts.push(
            `${report.missing} no longer in Telegram (will upload again)`,
          );
        }
        if (report.locked > 0) {
          parts.push('encrypted folders skipped');
        }
        if (report.snapshotCreatedAt === null && report.fromTags === 0) {
          parts.push('no index found in the channel');
        }
        onMessage(parts.join(' · '));
        await load();
      } catch (error) {
        if (error instanceof RestorePassphraseNeeded) {
          setAskPassphrase({ wrong: error.wrong });
        } else {
          onMessage(describeError(error));
        }
      } finally {
        setBusy(null);
        setStage(null);
      }
    },
    [
      guardBusy,
      load,
      onMessage,
      onSettingsRestored,
      refreshCounts,
      refreshTopics,
      restoreSettings,
      saveConfig,
    ],
  );

  const onAdopt = useCallback(async () => {
    if (guardBusy()) {
      return;
    }
    setBusy('adopt');
    try {
      const report = await adoptByNameAndSize((s, done, total) =>
        setStage({ stage: s, done, total }),
      );
      await refreshCounts();
      onMessage(
        `Matched ${report.adopted} file${report.adopted === 1 ? '' : 's'} already in Telegram` +
          (report.ambiguous > 0
            ? ` · ${report.ambiguous} ambiguous, will upload`
            : ''),
      );
      await load();
    } catch (error) {
      onMessage(describeError(error));
    } finally {
      setBusy(null);
      setStage(null);
    }
  }, [guardBusy, load, onMessage, refreshCounts]);

  const last = snapshots[0];
  const freshInstall =
    fileCount === 0 && state !== 'done' && state !== 'declined';

  return (
    <>
      <Card mode="outlined" style={styles.card}>
        <Card.Title
          title="Backup index"
          subtitle={
            last
              ? `Snapshot ${formatDate(last.createdAt)} · ${last.files} files`
              : 'No snapshot yet'
          }
        />
        <Card.Content>
          <Text variant="bodySmall" style={styles.dim}>
            Every upload carries a small tag in its caption, and a compressed
            copy of the whole index is kept in a "TeleSync Index" topic. After a
            reinstall or on a new phone, Restore rebuilds the index from
            Telegram so nothing is uploaded twice.
          </Text>
          {last && pending > 0 && (
            <Text variant="bodySmall" style={styles.dim}>
              {pending} newer upload{pending === 1 ? ' is' : 's are'} covered by
              caption tags until the next snapshot.
            </Text>
          )}
          {freshInstall && (
            <Text variant="bodySmall" style={styles.warn}>
              This install has no index yet. If you backed up before, restore
              first: syncing now would upload everything again.
            </Text>
          )}

          <View style={styles.checkRow}>
            <Checkbox.Android
              status={restoreSettings ? 'checked' : 'unchecked'}
              onPress={() => setRestoreSettings(value => !value)}
            />
            <Text variant="bodySmall" style={styles.checkLabel}>
              Also restore folder settings (size limit, extensions, schedule)
            </Text>
          </View>

          {stage && (
            <View style={styles.progress}>
              <Text variant="bodySmall" style={styles.dim}>
                {STAGE_LABEL[stage.stage]}
                {stage.total > 1 ? ` ${stage.done} / ${stage.total}` : ''}
              </Text>
              <ProgressBar
                indeterminate={stage.total <= 1}
                progress={stage.total > 1 ? stage.done / stage.total : 0}
              />
            </View>
          )}
        </Card.Content>
        <Card.Actions style={styles.actions}>
          <Button
            mode={freshInstall ? 'contained' : 'outlined'}
            loading={busy === 'restore'}
            disabled={busy !== null}
            onPress={() => {
              void onRestore();
            }}
          >
            Restore from Telegram
          </Button>
          <Button
            loading={busy === 'publish'}
            disabled={busy !== null || fileCount === 0}
            onPress={() => {
              void onPublish();
            }}
          >
            Save index now
          </Button>
        </Card.Actions>
        <Card.Actions style={styles.actions}>
          <Button
            compact
            loading={busy === 'adopt'}
            disabled={busy !== null}
            onPress={() => setConfirmAdopt(true)}
          >
            Match older backup
          </Button>
          {freshInstall && (
            <Button
              compact
              disabled={busy !== null}
              onPress={() => setConfirmFresh(true)}
            >
              Start fresh
            </Button>
          )}
        </Card.Actions>
      </Card>

      <Portal>
        <Dialog
          visible={askPassphrase !== null}
          onDismiss={() => setAskPassphrase(null)}
        >
          <Dialog.Title>Backup passphrase</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodySmall" style={styles.dim}>
              {askPassphrase?.wrong
                ? 'That passphrase does not open the encrypted part of the index. If you changed it at some point, try the older one.'
                : 'Part of the index belongs to encrypted folders. Enter the passphrase you used, or skip them for now and restore them later.'}
            </Text>
            <TextInput
              label="Passphrase"
              value={passphrase}
              onChangeText={setPassphrase}
              mode="outlined"
              secureTextEntry
              autoFocus
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button
              onPress={() => {
                setAskPassphrase(null);
                void onRestore({ skipEncrypted: true });
              }}
            >
              Skip encrypted
            </Button>
            <Button
              mode="contained"
              disabled={passphrase.length === 0}
              onPress={() => {
                const value = passphrase;
                setAskPassphrase(null);
                setPassphrase('');
                void onRestore({ passphrase: value });
              }}
            >
              Unlock
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={confirmFresh} onDismiss={() => setConfirmFresh(false)}>
          <Dialog.Title>Start fresh?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Sync will run without restoring the index. Files already in
              Telegram will be uploaded again as duplicates. Nothing is deleted.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmFresh(false)}>Cancel</Button>
            <Button
              onPress={() => {
                setConfirmFresh(false);
                void declineRestore()
                  .then(load)
                  .then(() => onMessage('Sync will start from scratch'));
              }}
            >
              Start fresh
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={confirmAdopt} onDismiss={() => setConfirmAdopt(false)}>
          <Dialog.Title>Match an older backup?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              For backups made before the index existed. Reads the whole channel
              and your bound folders, and marks a file as backed up when exactly
              one upload has the same name and size. Anything ambiguous still
              uploads. This can take a few minutes.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmAdopt(false)}>Cancel</Button>
            <Button
              onPress={() => {
                setConfirmAdopt(false);
                void onAdopt();
              }}
            >
              Match
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 16 },
  dim: { opacity: 0.7, marginBottom: 10 },
  warn: { color: '#B3261E', marginBottom: 10 },
  checkRow: { flexDirection: 'row', alignItems: 'center', marginLeft: -8 },
  checkLabel: { flex: 1, opacity: 0.8 },
  progress: { marginTop: 8, gap: 6 },
  actions: { justifyContent: 'flex-start', flexWrap: 'wrap', gap: 8 },
});

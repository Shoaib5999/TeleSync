import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  Button,
  Card,
  Dialog,
  Divider,
  List,
  Portal,
  Snackbar,
  Text,
} from 'react-native-paper';

import {
  approveAll,
  approveDeletion,
  clearResolved,
  dismissAll,
  dismissDeletion,
  pendingDeletions,
} from '../services/sync/deletions';
import { describeError } from '../utils/logger';
import type { DeletionRecord } from '../types';

function formatSize(bytes: number): string {
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function shortPath(path: string): string {
  return path.replace('/storage/emulated/0/', '');
}

/**
 * Review queue for mirrored deletions.
 *
 * Nothing here has been removed from Telegram. Each row is a proposal, and the
 * Telegram copy only goes away when it is approved on this screen.
 */
export default function DeletionsScreen(): React.JSX.Element {
  const [records, setRecords] = useState<DeletionRecord[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmOne, setConfirmOne] = useState<DeletionRecord | null>(null);

  const load = useCallback(async () => {
    try {
      setRecords(await pendingDeletions());
    } catch (error) {
      setMessage(describeError(error));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onApprove = useCallback(
    async (record: DeletionRecord) => {
      setBusy(true);
      try {
        await approveDeletion(record);
        setMessage('Deleted from Telegram');
        await load();
      } catch (error) {
        setMessage(describeError(error));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const onDismiss = useCallback(
    async (record: DeletionRecord) => {
      try {
        await dismissDeletion(record);
        setMessage('Kept in Telegram; it will not be proposed again');
        await load();
      } catch (error) {
        setMessage(describeError(error));
      }
    },
    [load],
  );

  return (
    <>
      <FlatList
        contentContainerStyle={styles.container}
        data={records}
        keyExtractor={item => String(item.id)}
        onRefresh={load}
        refreshing={false}
        ListHeaderComponent={
          <Card mode="outlined" style={styles.card}>
            <Card.Title
              title="Deleted from this phone"
              subtitle={
                records.length === 0
                  ? 'Nothing waiting'
                  : `${records.length} awaiting your decision`
              }
            />
            <Card.Content>
              <Text variant="bodySmall" style={styles.dim}>
                These files are gone from folders you marked for deletion
                mirroring. They are still safely in Telegram. Nothing is removed
                unless you approve it here.
              </Text>
            </Card.Content>
            {records.length > 0 && (
              <Card.Actions style={styles.actions}>
                <Button
                  textColor="#B3261E"
                  disabled={busy}
                  onPress={() => setConfirmAll(true)}
                >
                  Delete all
                </Button>
                <Button
                  disabled={busy}
                  onPress={() => {
                    void dismissAll(records)
                      .then(load)
                      .then(() => setMessage('Kept everything'));
                  }}
                >
                  Keep all
                </Button>
              </Card.Actions>
            )}
          </Card>
        }
        ListEmptyComponent={
          <Text variant="bodyMedium" style={styles.empty}>
            Nothing to review. Files only appear here when they disappear from a
            folder that has deletion mirroring switched on.
          </Text>
        }
        renderItem={({ item }) => (
          <List.Item
            title={shortPath(item.local_path)}
            titleNumberOfLines={2}
            description={`${formatSize(item.size)} · message #${item.message_id}`}
            left={props => <List.Icon {...props} icon="file-remove-outline" />}
            right={() => (
              <View style={styles.rowActions}>
                <Button
                  compact
                  disabled={busy}
                  onPress={() => {
                    void onDismiss(item);
                  }}
                >
                  Keep
                </Button>
                <Button
                  compact
                  textColor="#B3261E"
                  disabled={busy}
                  onPress={() => setConfirmOne(item)}
                >
                  Delete
                </Button>
              </View>
            )}
          />
        )}
        ItemSeparatorComponent={Divider}
        ListFooterComponent={
          <Button
            style={styles.footerButton}
            disabled={records.length > 0}
            onPress={() => {
              void clearResolved()
                .then(load)
                .then(() => setMessage('History cleared'));
            }}
          >
            Clear resolved history
          </Button>
        }
      />

      <Portal>
        <Dialog
          visible={confirmOne !== null}
          onDismiss={() => setConfirmOne(null)}
        >
          <Dialog.Title>Delete from Telegram?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              This permanently removes the backup of{'\n'}
              {confirmOne ? shortPath(confirmOne.local_path) : ''}.{'\n\n'}
              The file is already gone from this phone, so this is your last
              copy. It cannot be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmOne(null)}>Cancel</Button>
            <Button
              textColor="#B3261E"
              onPress={() => {
                const record = confirmOne;
                setConfirmOne(null);
                if (record) {
                  void onApprove(record);
                }
              }}
            >
              Delete
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={confirmAll} onDismiss={() => setConfirmAll(false)}>
          <Dialog.Title>
            Delete all {records.length} from Telegram?
          </Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              These are your last remaining copies — the files are already gone
              from this phone. This cannot be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setConfirmAll(false)}>Cancel</Button>
            <Button
              textColor="#B3261E"
              onPress={() => {
                setConfirmAll(false);
                setBusy(true);
                void approveAll(records)
                  .then(result => {
                    setMessage(
                      `Deleted ${result.deleted}${result.failed > 0 ? `, ${result.failed} failed` : ''}`,
                    );
                  })
                  .then(load)
                  .finally(() => setBusy(false));
              }}
            >
              Delete all
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={message !== null}
        onDismiss={() => setMessage(null)}
        duration={4000}
      >
        {message ?? ''}
      </Snackbar>
    </>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 32 },
  card: { marginBottom: 16 },
  dim: { opacity: 0.7 },
  empty: { textAlign: 'center', marginTop: 32, opacity: 0.6 },
  actions: { justifyContent: 'flex-start', gap: 8 },
  rowActions: { flexDirection: 'row', alignItems: 'center' },
  footerButton: { marginTop: 24 },
});

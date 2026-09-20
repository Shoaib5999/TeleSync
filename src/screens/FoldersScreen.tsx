import React, { useCallback, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import {
  Button,
  Card,
  Dialog,
  Divider,
  IconButton,
  List,
  Menu,
  Portal,
  Snackbar,
  Text,
  TextInput,
} from 'react-native-paper';

import { useAppStore } from '../state/store';
import { topicsRepo } from '../services/db/schema';
import { vault } from '../services/crypto/vault';
import { pickFolder } from '../services/sync/scanner';
import { startForegroundSync } from '../background/foreground';
import { syncEngine } from '../services/sync/engine';
import { describeError } from '../utils/logger';
import type { TopicRecord } from '../types';

/**
 * Binds local folders to topics. A folder with no binding still gets backed up,
 * to the root topic — the binding only decides which topic a file lands in.
 */
export default function FoldersScreen(): React.JSX.Element {
  const { topics, refreshTopics } = useAppStore();
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<TopicRecord | null>(null);
  const [folderInput, setFolderInput] = useState('');
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [addVisible, setAddVisible] = useState(false);
  const [pendingFolder, setPendingFolder] = useState('');

  const bound = topics.filter(topic => topic.local_folder);
  const unbound = topics.filter(topic => !topic.local_folder);

  const onPick = useCallback(async () => {
    try {
      const path = await pickFolder();
      if (path) {
        setPendingFolder(path);
        setAddVisible(true);
      }
    } catch (error) {
      setMessage(describeError(error));
    }
  }, []);

  const onBind = useCallback(
    async (topicId: number, folder: string) => {
      try {
        await topicsRepo.bindFolder(topicId, folder || null);
        await refreshTopics();
        setMessage(folder ? 'Folder bound' : 'Binding removed');
      } catch (error) {
        setMessage(describeError(error));
      }
    },
    [refreshTopics],
  );

  /**
   * Turning encryption ON requires a passphrase to already exist, otherwise the
   * next sync would fail partway through with nothing to encrypt with.
   */
  const onToggleEncrypt = useCallback(
    async (topic: TopicRecord) => {
      try {
        if (!topic.encrypt && !(await vault.isUnlocked())) {
          setMessage(
            'Set an encryption passphrase in Settings before encrypting a folder.',
          );
          return;
        }
        await topicsRepo.setEncrypt(topic.topic_id, !topic.encrypt);
        await refreshTopics();
        setMessage(
          topic.encrypt
            ? 'Encryption off. Files already uploaded stay encrypted.'
            : 'Encryption on for new uploads from this folder.',
        );
      } catch (error) {
        setMessage(describeError(error));
      }
    },
    [refreshTopics],
  );

  const onToggleMirror = useCallback(
    async (topic: TopicRecord) => {
      try {
        await topicsRepo.setMirrorDeletes(
          topic.topic_id,
          !topic.mirror_deletes,
        );
        await refreshTopics();
        setMessage(
          topic.mirror_deletes
            ? 'Deletion mirroring off.'
            : 'Deletion mirroring on. Deletions are proposed for review, never automatic.',
        );
      } catch (error) {
        setMessage(describeError(error));
      }
    },
    [refreshTopics],
  );

  /** Backs up just this binding, without touching anything else. */
  const onSyncOne = useCallback(async (topic: TopicRecord) => {
    if (!topic.local_folder) {
      return;
    }
    if (syncEngine.isRunning) {
      setMessage('A sync is already running.');
      return;
    }
    try {
      await startForegroundSync({
        folders: [topic.local_folder],
        includeAllMedia: false,
        label: topic.title,
      });
    } catch (error) {
      setMessage(describeError(error));
    }
  }, []);

  return (
    <>
      <FlatList
        contentContainerStyle={styles.container}
        data={bound}
        keyExtractor={item => String(item.topic_id)}
        ListHeaderComponent={
          <Card mode="outlined" style={styles.card}>
            <Card.Title title="Folder routing" />
            <Card.Content>
              <Text variant="bodySmall" style={styles.dim}>
                Files go to the topic whose bound folder is the longest match
                for their path. Anything unmatched goes to the root topic set in
                Settings.
              </Text>
            </Card.Content>
            <Card.Actions>
              <Button mode="contained" onPress={onPick} icon="folder-plus">
                Add folder
              </Button>
              <Button
                onPress={() => {
                  setPendingFolder('');
                  setAddVisible(true);
                }}
              >
                Type path
              </Button>
            </Card.Actions>
          </Card>
        }
        ListEmptyComponent={
          <Text variant="bodyMedium" style={styles.empty}>
            No folders bound yet. Load your topics on the Topics tab, then bind
            a folder to each.
          </Text>
        }
        renderItem={({ item }) => (
          <List.Item
            title={item.title}
            description={`${item.local_folder ?? ''}${
              item.encrypt ? '\n🔒 encrypted' : ''
            }${item.mirror_deletes ? '\n🗑 deletions mirrored' : ''}`}
            descriptionNumberOfLines={3}
            left={props => <List.Icon {...props} icon="folder" />}
            right={props => (
              <Menu
                visible={menuFor === item.topic_id}
                onDismiss={() => setMenuFor(null)}
                anchor={
                  <IconButton
                    {...props}
                    icon="dots-vertical"
                    onPress={() => setMenuFor(item.topic_id)}
                  />
                }
              >
                <Menu.Item
                  title="Edit binding"
                  leadingIcon="pencil"
                  onPress={() => {
                    setMenuFor(null);
                    setEditing(item);
                    setFolderInput(item.local_folder ?? '');
                  }}
                />
                <Menu.Item
                  title="Sync this folder now"
                  leadingIcon="cloud-upload"
                  onPress={() => {
                    setMenuFor(null);
                    void onSyncOne(item);
                  }}
                />
                <Menu.Item
                  title={
                    item.encrypt ? 'Turn off encryption' : 'Encrypt this folder'
                  }
                  leadingIcon={item.encrypt ? 'lock-open-variant' : 'lock'}
                  onPress={() => {
                    setMenuFor(null);
                    void onToggleEncrypt(item);
                  }}
                />
                <Menu.Item
                  title={
                    item.mirror_deletes
                      ? 'Stop mirroring deletions'
                      : 'Mirror deletions'
                  }
                  leadingIcon="delete-sync"
                  onPress={() => {
                    setMenuFor(null);
                    void onToggleMirror(item);
                  }}
                />
                <Menu.Item
                  title="Remove binding"
                  leadingIcon="link-off"
                  onPress={() => {
                    setMenuFor(null);
                    void onBind(item.topic_id, '');
                  }}
                />
              </Menu>
            )}
          />
        )}
        ItemSeparatorComponent={Divider}
      />

      {/* Choose which topic a newly picked folder belongs to. */}
      <Portal>
        <Dialog visible={addVisible} onDismiss={() => setAddVisible(false)}>
          <Dialog.Title>Bind folder to a topic</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Folder path"
              value={pendingFolder}
              onChangeText={setPendingFolder}
              mode="outlined"
              placeholder="/storage/emulated/0/DCIM/Camera"
              style={styles.input}
            />
            <Text variant="bodySmall" style={styles.dim}>
              Pick the topic to receive files from this folder:
            </Text>
            <View style={styles.topicList}>
              {[...bound, ...unbound].map(topic => (
                <Button
                  key={topic.topic_id}
                  mode="outlined"
                  compact
                  style={styles.topicChip}
                  onPress={() => {
                    setAddVisible(false);
                    void onBind(topic.topic_id, pendingFolder.trim());
                  }}
                >
                  {topic.title}
                </Button>
              ))}
            </View>
            {topics.length === 0 && (
              <Text variant="bodySmall" style={styles.warn}>
                No topics loaded. Open the Topics tab and tap Refresh first.
              </Text>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAddVisible(false)}>Cancel</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog visible={editing !== null} onDismiss={() => setEditing(null)}>
          <Dialog.Title>Edit binding</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodySmall" style={styles.dim}>
              {editing?.title}
            </Text>
            <TextInput
              label="Folder path"
              value={folderInput}
              onChangeText={setFolderInput}
              mode="outlined"
              style={styles.input}
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setEditing(null)}>Cancel</Button>
            <Button
              onPress={() => {
                const topic = editing;
                setEditing(null);
                if (topic) {
                  void onBind(topic.topic_id, folderInput.trim());
                }
              }}
            >
              Save
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
  warn: { marginTop: 12, color: '#B3261E' },
  empty: { textAlign: 'center', marginTop: 32, opacity: 0.6 },
  input: { marginBottom: 12 },
  topicList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  topicChip: { marginRight: 4, marginBottom: 4 },
});

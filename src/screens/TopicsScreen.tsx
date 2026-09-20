import React, { useCallback, useEffect, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
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
import {
  createTopic,
  deleteTopic,
  listTopics,
  renameTopic,
} from '../services/telegram/topics';
import { describeError } from '../utils/logger';
import type { RemoteTopic } from '../types';

export default function TopicsScreen(): React.JSX.Element {
  const {
    remoteTopics,
    setRemoteTopics,
    topicsLoading,
    setTopicsLoading,
    refreshTopics,
  } = useAppStore();
  const [message, setMessage] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [createVisible, setCreateVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<RemoteTopic | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RemoteTopic | null>(null);
  const [titleInput, setTitleInput] = useState('');

  const load = useCallback(async () => {
    setTopicsLoading(true);
    try {
      const topics = await listTopics();
      setRemoteTopics(topics);
      await refreshTopics();
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setTopicsLoading(false);
    }
  }, [setRemoteTopics, setTopicsLoading, refreshTopics]);

  useEffect(() => {
    // Only auto-load once, and only if we have nothing cached: this is a
    // network call and the tab may be opened before the user has configured a
    // channel.
    if (remoteTopics.length === 0) {
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCreate = useCallback(async () => {
    const title = titleInput.trim();
    setCreateVisible(false);
    setTitleInput('');
    if (!title) {
      return;
    }
    try {
      await createTopic(title);
      setMessage(`Created "${title}"`);
      await load();
    } catch (error) {
      setMessage(describeError(error));
    }
  }, [titleInput, load]);

  const onRename = useCallback(async () => {
    const target = renameTarget;
    const title = titleInput.trim();
    setRenameTarget(null);
    setTitleInput('');
    if (!target || !title) {
      return;
    }
    try {
      await renameTopic(target.id, title);
      setMessage('Topic renamed');
      await load();
    } catch (error) {
      setMessage(describeError(error));
    }
  }, [renameTarget, titleInput, load]);

  const onDelete = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) {
      return;
    }
    try {
      await deleteTopic(target.id);
      setMessage(`Deleted "${target.title}"`);
      await load();
    } catch (error) {
      setMessage(describeError(error));
    }
  }, [deleteTarget, load]);

  return (
    <>
      <FlatList
        contentContainerStyle={styles.container}
        data={remoteTopics}
        keyExtractor={item => String(item.id)}
        refreshing={topicsLoading}
        onRefresh={load}
        ListHeaderComponent={
          <Card mode="outlined" style={styles.card}>
            <Card.Title
              title="Channel topics"
              subtitle="Pulled live from Telegram"
            />
            <Card.Content>
              <Text variant="bodySmall" style={styles.dim}>
                Topics act as folders inside the channel. Bind each one to a
                local folder on the Folders tab.
              </Text>
            </Card.Content>
            <Card.Actions>
              <Button
                mode="contained"
                icon="plus"
                onPress={() => setCreateVisible(true)}
              >
                New topic
              </Button>
              <Button onPress={load} loading={topicsLoading}>
                Refresh
              </Button>
            </Card.Actions>
          </Card>
        }
        ListEmptyComponent={
          <Text variant="bodyMedium" style={styles.empty}>
            {topicsLoading
              ? ''
              : 'No topics found. Check the channel ID in Settings and that Topics are enabled on the channel.'}
          </Text>
        }
        renderItem={({ item }) => (
          <List.Item
            title={item.title}
            description={`#${item.id}${item.closed ? ' · closed' : ''}${item.isGeneral ? ' · general' : ''}`}
            left={props => (
              <List.Icon {...props} icon={item.isGeneral ? 'forum' : 'pound'} />
            )}
            right={props =>
              item.isGeneral ? null : (
                <Menu
                  visible={menuFor === item.id}
                  onDismiss={() => setMenuFor(null)}
                  anchor={
                    <IconButton
                      {...props}
                      icon="dots-vertical"
                      onPress={() => setMenuFor(item.id)}
                    />
                  }
                >
                  <Menu.Item
                    title="Rename"
                    leadingIcon="pencil"
                    onPress={() => {
                      setMenuFor(null);
                      setRenameTarget(item);
                      setTitleInput(item.title);
                    }}
                  />
                  <Menu.Item
                    title="Delete"
                    leadingIcon="delete"
                    onPress={() => {
                      setMenuFor(null);
                      setDeleteTarget(item);
                    }}
                  />
                </Menu>
              )
            }
          />
        )}
        ItemSeparatorComponent={Divider}
      />

      <Portal>
        <Dialog
          visible={createVisible}
          onDismiss={() => setCreateVisible(false)}
        >
          <Dialog.Title>New topic</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Title"
              value={titleInput}
              onChangeText={setTitleInput}
              mode="outlined"
              placeholder="Personal Photos"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setCreateVisible(false)}>Cancel</Button>
            <Button onPress={onCreate}>Create</Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog
          visible={renameTarget !== null}
          onDismiss={() => setRenameTarget(null)}
        >
          <Dialog.Title>Rename topic</Dialog.Title>
          <Dialog.Content>
            <TextInput
              label="Title"
              value={titleInput}
              onChangeText={setTitleInput}
              mode="outlined"
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setRenameTarget(null)}>Cancel</Button>
            <Button onPress={onRename}>Save</Button>
          </Dialog.Actions>
        </Dialog>

        {/* Destructive and irreversible, so it is spelled out explicitly. */}
        <Dialog
          visible={deleteTarget !== null}
          onDismiss={() => setDeleteTarget(null)}
        >
          <Dialog.Title>Delete topic?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              This permanently deletes "{deleteTarget?.title}" and every message
              in it from Telegram. Your local files are not touched, and this
              cannot be undone.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setDeleteTarget(null)}>Cancel</Button>
            <Button textColor="#B3261E" onPress={onDelete}>
              Delete
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
});

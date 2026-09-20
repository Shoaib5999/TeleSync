import React, { useCallback, useState } from 'react';
import { FlatList, Image, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import {
  ActivityIndicator,
  Button,
  Card,
  Dialog,
  IconButton,
  List,
  Portal,
  ProgressBar,
  Snackbar,
  Text,
} from 'react-native-paper';
import Video from 'react-native-video';

import {
  clearPreviewCache,
  fetchToCache,
  listBackedUpFiles,
  mediaKindOf,
  originalNameOf,
  restoreToOriginalPath,
  type MediaKind,
} from '../services/telegram/download';
import { vault } from '../services/crypto/vault';
import { describeError } from '../utils/logger';
import type { FileRecord } from '../types';

function formatSize(bytes: number): string {
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const ICON_FOR: Record<MediaKind, string> = {
  image: 'image-outline',
  video: 'play-circle-outline',
  other: 'file-outline',
};

/**
 * Browse what is backed up, preview it, and restore it.
 *
 * Previewing fetches into app-private cache only. Nothing reaches the device's
 * own storage until "Save to device" is tapped.
 */
export default function LibraryScreen(): React.JSX.Element {
  const [files, setFiles] = useState<FileRecord[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [open, setOpen] = useState<FileRecord | null>(null);
  const [localPath, setLocalPath] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [fetchProgress, setFetchProgress] = useState(0);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setFiles(await listBackedUpFiles());
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /** Downloads (and decrypts) into the private cache so it can be shown. */
  const onPreview = useCallback(async (record: FileRecord) => {
    setOpen(record);
    setLocalPath(null);
    setFetchProgress(0);

    if (record.encrypted && !(await vault.isUnlocked())) {
      setMessage(
        'This file is encrypted. Set your passphrase in Settings to open it.',
      );
      setOpen(null);
      return;
    }

    setFetching(true);
    try {
      const path = await fetchToCache(record, {
        onProgress: setFetchProgress,
      });
      setLocalPath(path);
    } catch (error) {
      setMessage(describeError(error));
      setOpen(null);
    } finally {
      setFetching(false);
    }
  }, []);

  const onSave = useCallback(async () => {
    if (!open) {
      return;
    }
    setSaving(true);
    try {
      const path = await restoreToOriginalPath(open);
      setMessage(`Saved to ${path.replace('/storage/emulated/0/', '')}`);
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setSaving(false);
    }
  }, [open]);

  const kind = open ? mediaKindOf(originalNameOf(open)) : 'other';

  return (
    <>
      <FlatList
        contentContainerStyle={styles.container}
        data={files}
        keyExtractor={item => String(item.id)}
        refreshing={loading}
        onRefresh={load}
        ListHeaderComponent={
          <Card mode="outlined" style={styles.card}>
            <Card.Title
              title="Backed up"
              subtitle={`${files.length} file${files.length === 1 ? '' : 's'}`}
            />
            <Card.Content>
              <Text variant="bodySmall" style={styles.dim}>
                Tap anything to preview it. Previews stay inside the app —
                nothing reaches your gallery until you choose to save it.
              </Text>
            </Card.Content>
            <Card.Actions>
              <Button
                onPress={() => {
                  void clearPreviewCache().then(() =>
                    setMessage('Preview cache cleared'),
                  );
                }}
              >
                Clear preview cache
              </Button>
            </Card.Actions>
          </Card>
        }
        ListEmptyComponent={
          <Text variant="bodyMedium" style={styles.empty}>
            Nothing backed up yet, or this device has not indexed the channel.
          </Text>
        }
        renderItem={({ item }) => {
          const name = originalNameOf(item);
          return (
            <List.Item
              title={name}
              titleNumberOfLines={1}
              description={`${formatSize(item.size)}${item.encrypted ? ' · encrypted' : ''}`}
              left={props => (
                <List.Icon {...props} icon={ICON_FOR[mediaKindOf(name)]} />
              )}
              right={props => (
                <IconButton
                  {...props}
                  icon="eye-outline"
                  onPress={() => {
                    void onPreview(item);
                  }}
                />
              )}
              onPress={() => {
                void onPreview(item);
              }}
            />
          );
        }}
      />

      <Portal>
        <Dialog
          visible={open !== null}
          onDismiss={() => {
            setOpen(null);
            setLocalPath(null);
          }}
          style={styles.dialog}
        >
          <Dialog.Title numberOfLines={1}>
            {open ? originalNameOf(open) : ''}
          </Dialog.Title>
          <Dialog.Content>
            {fetching && (
              <View style={styles.center}>
                <ActivityIndicator />
                <Text variant="bodySmall" style={styles.dim}>
                  {open?.encrypted
                    ? 'Downloading and decrypting…'
                    : 'Downloading…'}
                </Text>
                <ProgressBar progress={fetchProgress} style={styles.progress} />
                {open && open.size > 20 * 1048576 && (
                  <Text variant="bodySmall" style={styles.dim}>
                    {formatSize(open.size)} — large files take a moment.
                  </Text>
                )}
              </View>
            )}

            {!fetching && localPath && kind === 'image' && (
              <Image
                source={{ uri: `file://${localPath}` }}
                style={styles.image}
                resizeMode="contain"
              />
            )}

            {!fetching && localPath && kind === 'video' && (
              <Video
                source={{ uri: `file://${localPath}` }}
                style={styles.video}
                controls
                paused={false}
                resizeMode="contain"
              />
            )}

            {!fetching && localPath && kind === 'other' && (
              <Text variant="bodyMedium">
                Downloaded and ready. This file type cannot be previewed here.
              </Text>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button
              onPress={() => {
                setOpen(null);
                setLocalPath(null);
              }}
            >
              Close
            </Button>
            <Button
              mode="contained"
              loading={saving}
              disabled={!localPath || saving}
              onPress={onSave}
            >
              Save to device
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

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

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 32 },
  card: { marginBottom: 16 },
  dim: { opacity: 0.7, marginTop: 6, textAlign: 'center' },
  empty: { textAlign: 'center', marginTop: 32, opacity: 0.6 },
  dialog: { maxHeight: '85%' },
  center: { alignItems: 'center', paddingVertical: 16 },
  progress: { width: '100%', height: 6, borderRadius: 3, marginTop: 12 },
  image: { width: '100%', height: 320, borderRadius: 8 },
  video: {
    width: '100%',
    height: 260,
    borderRadius: 8,
    backgroundColor: '#000',
  },
});

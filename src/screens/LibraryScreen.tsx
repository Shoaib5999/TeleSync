import React, { useCallback, useMemo, useState } from 'react';
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
  TextInput,
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
import { VaultPassphraseRequiredError } from '../services/crypto/vault';
import { describeError } from '../utils/logger';
import type { FileRecord } from '../types';
import SmartSearchHeader from './search/SmartSearchHeader';
import type { SearchResult } from '../services/search/feeder';

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

  const [ask, setAsk] = useState<{ record: FileRecord; wrong: boolean } | null>(
    null,
  );
  const [askValue, setAskValue] = useState('');

  /** null = browsing everything; otherwise the smart-search hits, ranked. */
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const snippets = useMemo(
    () =>
      new Map((results ?? []).map(r => [r.record.local_path, r.hit.snippet])),
    [results],
  );

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

  /**
   * Downloads (and decrypts) into the private cache so it can be shown.
   *
   * An encrypted file whose key this device does not know yet (a backup from
   * another phone or an earlier install) asks for the passphrase and retries.
   */
  const onPreview = useCallback(
    async (record: FileRecord, passphrase?: string) => {
      setOpen(record);
      setLocalPath(null);
      setFetchProgress(0);
      setFetching(true);
      try {
        const path = await fetchToCache(record, {
          onProgress: setFetchProgress,
          passphrase,
        });
        setLocalPath(path);
      } catch (error) {
        if (error instanceof VaultPassphraseRequiredError) {
          setAsk({ record, wrong: error.wrongPassphrase });
        } else {
          setMessage(describeError(error));
        }
        setOpen(null);
      } finally {
        setFetching(false);
      }
    },
    [],
  );

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
        data={results ? results.map(result => result.record) : files}
        keyExtractor={item => String(item.id)}
        keyboardShouldPersistTaps="handled"
        refreshing={loading}
        onRefresh={load}
        ListHeaderComponent={
          <>
            <SmartSearchHeader onResults={setResults} onMessage={setMessage} />
            {results ? (
              <Text variant="bodySmall" style={styles.resultCount}>
                {results.length} match{results.length === 1 ? '' : 'es'}
              </Text>
            ) : (
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
            )}
          </>
        }
        ListEmptyComponent={
          <Text variant="bodyMedium" style={styles.empty}>
            {results
              ? 'No matches. Photos are still being analysed if the index is not finished.'
              : 'Nothing backed up yet, or this device has not indexed the channel.'}
          </Text>
        }
        renderItem={({ item }) => {
          const name = originalNameOf(item);
          const snippet = results ? snippets.get(item.local_path) : undefined;
          const itemKind = mediaKindOf(name);
          return (
            <List.Item
              title={name}
              titleNumberOfLines={1}
              description={`${formatSize(item.size)}${item.encrypted ? ' · encrypted' : ''}${snippet ? `\n${snippet}` : ''}`}
              descriptionNumberOfLines={snippet ? 3 : 1}
              left={props =>
                results && itemKind === 'image' && !item.encrypted ? (
                  // The local original, downsampled by the decoder; search
                  // results are always files that live on this phone.
                  <Image
                    source={{ uri: `file://${item.local_path}` }}
                    style={styles.thumb}
                    resizeMethod="resize"
                  />
                ) : (
                  <List.Icon {...props} icon={ICON_FOR[itemKind]} />
                )
              }
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
        <Dialog visible={ask !== null} onDismiss={() => setAsk(null)}>
          <Dialog.Title>Backup passphrase</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodySmall" style={styles.askText}>
              {ask?.wrong
                ? 'That passphrase does not open this file. If you changed it at some point, try the older one.'
                : 'This file was encrypted on another device or an earlier install. Enter the passphrase you used then. It is remembered after it works, so you only do this once.'}
            </Text>
            <TextInput
              label="Passphrase"
              value={askValue}
              onChangeText={setAskValue}
              mode="outlined"
              secureTextEntry
              autoFocus
            />
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setAsk(null)}>Cancel</Button>
            <Button
              mode="contained"
              disabled={askValue.length === 0}
              onPress={() => {
                const pending = ask;
                const value = askValue;
                setAsk(null);
                setAskValue('');
                if (pending) {
                  void onPreview(pending.record, value);
                }
              }}
            >
              Unlock
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
  resultCount: { opacity: 0.7, marginBottom: 4, marginLeft: 4 },
  thumb: { width: 48, height: 48, borderRadius: 6, marginLeft: 8 },
  dialog: { maxHeight: '85%' },
  askText: { marginBottom: 12 },
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

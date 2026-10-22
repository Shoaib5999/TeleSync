import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import {
  Button,
  Dialog,
  Icon,
  IconButton,
  Portal,
  ProgressBar,
  Text,
} from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ReactNativeBlobUtil from 'react-native-blob-util';
import Video from 'react-native-video';

import {
  cachedVaultItem,
  fetchVaultItem,
  saveVaultItem,
  type VaultItem,
  type VaultKind,
} from '../../services/telegram/browse';
import { VaultPassphraseRequiredError } from '../../services/crypto/vault';
import { describeError } from '../../utils/logger';
import PassphraseDialog from './PassphraseDialog';
import { useVaultSession } from './session';
import ZoomableImage from './viewers/ZoomableImage';
import PdfView from './viewers/PdfView';
import TextView from './viewers/TextView';

export function formatSize(bytes: number): string {
  if (bytes >= 1073741824) {
    return `${(bytes / 1073741824).toFixed(2)} GB`;
  }
  if (bytes >= 1048576) {
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const KIND_ICON: Record<VaultKind, string> = {
  image: 'image-outline',
  video: 'play-circle-outline',
  audio: 'music-note',
  pdf: 'file-pdf-box',
  text: 'file-document-outline',
  archive: 'folder-zip-outline',
  other: 'file-outline',
  message: 'message-text-outline',
};

/**
 * Full-screen viewer for one Vault item, with paging to its neighbours.
 *
 * Rendered through Paper's Portal inside the activity window, not an RN
 * Modal: a Modal is a separate Android window that FLAG_SECURE on the
 * activity would not cover, so screenshots of it would still work.
 */
export default function ViewerOverlay({
  items,
  index,
  topicTitle,
  onIndexChange,
  onClose,
  onMessage,
}: {
  items: VaultItem[];
  index: number;
  topicTitle: string;
  onIndexChange: (next: number) => void;
  onClose: () => void;
  onMessage: (text: string) => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const item = items[index];

  const [path, setPath] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cannotRender, setCannotRender] = useState(false);
  const [ask, setAsk] = useState<{ wrong: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [openWithVisible, setOpenWithVisible] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async (target: VaultItem, passphrase?: string) => {
    abortRef.current?.abort();
    setPath(null);
    setError(null);
    setCannotRender(false);
    setProgress(0);
    if (target.kind === 'message') {
      return;
    }
    const cached = await cachedVaultItem(target);
    if (cached) {
      setPath(cached);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setFetching(true);
    try {
      const result = await fetchVaultItem(target, {
        onProgress: setProgress,
        signal: controller.signal,
        passphrase,
      });
      if (!controller.signal.aborted) {
        setPath(result);
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return;
      }
      if (err instanceof VaultPassphraseRequiredError) {
        setAsk({ wrong: err.wrongPassphrase });
      } else {
        setError(describeError(err));
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setFetching(false);
      }
    }
  }, []);

  useEffect(() => {
    if (item) {
      void load(item);
    }
  }, [item, load]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const go = useCallback(
    (direction: 'next' | 'prev') => {
      const next = direction === 'next' ? index + 1 : index - 1;
      if (next >= 0 && next < items.length) {
        onIndexChange(next);
      }
    },
    [index, items.length, onIndexChange],
  );

  const onSave = useCallback(async () => {
    if (!item) {
      return;
    }
    setSaving(true);
    try {
      const saved = await saveVaultItem(item, topicTitle);
      onMessage(`Saved to ${saved.replace('/storage/emulated/0/', '')}`);
    } catch (err) {
      if (err instanceof VaultPassphraseRequiredError) {
        setAsk({ wrong: err.wrongPassphrase });
      } else {
        onMessage(describeError(err));
      }
    } finally {
      setSaving(false);
    }
  }, [item, topicTitle, onMessage]);

  const onOpenWith = useCallback(async () => {
    setOpenWithVisible(false);
    if (!path || !item) {
      return;
    }
    try {
      // The other app taking the screen is intended, not the user leaving.
      useVaultSession.getState().expectLeave();
      await ReactNativeBlobUtil.android.actionViewIntent(
        path,
        item.mime,
        'Open with',
      );
    } catch (err) {
      onMessage(`No app could open it: ${describeError(err)}`);
    }
  }, [path, item, onMessage]);

  if (!item) {
    return <View />;
  }

  const fileUri = path ? `file://${path}` : null;

  let body: React.ReactNode;
  if (item.kind === 'message') {
    body = <TextView name="message.txt" inlineText={item.text} />;
  } else if (fetching || (!path && !error && !ask)) {
    body = (
      <View style={styles.center}>
        <Icon source={KIND_ICON[item.kind]} size={56} color="#fff" />
        <Text style={styles.light}>
          {item.encrypted ? 'Downloading and decrypting…' : 'Downloading…'}
        </Text>
        <ProgressBar progress={progress} style={styles.progress} />
        <Text style={styles.dim}>
          {formatSize(item.size * progress)} of {formatSize(item.size)}
        </Text>
        {item.encrypted && item.kind === 'video' && (
          <Text style={styles.dim}>
            Encrypted videos must download in full before they can play.
          </Text>
        )}
        <Button
          textColor="#fff"
          onPress={() => {
            abortRef.current?.abort();
            onClose();
          }}
        >
          Cancel
        </Button>
      </View>
    );
  } else if (error || !path) {
    body = (
      <View style={styles.center}>
        <Icon source="alert-circle-outline" size={48} color="#fff" />
        <Text style={styles.light}>
          {error ?? 'This file needs its encryption passphrase.'}
        </Text>
        <Button
          mode="contained"
          onPress={() => {
            void load(item);
          }}
        >
          Try again
        </Button>
      </View>
    );
  } else if (item.kind === 'image' && !cannotRender && fileUri) {
    body = (
      <ZoomableImage
        key={item.key}
        uri={fileUri}
        onSwipe={go}
        onError={() => setCannotRender(true)}
      />
    );
  } else if ((item.kind === 'video' || item.kind === 'audio') && fileUri) {
    body = (
      <View style={styles.fill}>
        {item.kind === 'audio' && (
          <View style={styles.center}>
            <Icon source="music-circle-outline" size={96} color="#fff" />
            <Text style={styles.light}>{item.name}</Text>
          </View>
        )}
        <Video
          key={item.key}
          source={{ uri: fileUri }}
          style={item.kind === 'audio' ? styles.audio : styles.fill}
          controls
          paused={false}
          resizeMode="contain"
          onError={() => setCannotRender(true)}
        />
        {cannotRender && (
          <Text style={styles.dim}>
            This format could not be played here. Try "Open with".
          </Text>
        )}
      </View>
    );
  } else if (item.kind === 'pdf' && path) {
    body = (
      <PdfView key={item.key} path={path} cacheKey={String(item.messageId)} />
    );
  } else if (item.kind === 'text' && path) {
    body = <TextView key={item.key} path={path} name={item.name} />;
  } else {
    body = (
      <View style={styles.center}>
        <Icon source={KIND_ICON[item.kind]} size={72} color="#fff" />
        <Text style={styles.light}>{item.name}</Text>
        <Text style={styles.dim}>
          {cannotRender
            ? 'This image format cannot be shown here.'
            : 'This file type has no built-in viewer.'}{' '}
          Save it, or open it with another app.
        </Text>
        <View style={styles.row}>
          <Button mode="contained" onPress={() => setOpenWithVisible(true)}>
            Open with…
          </Button>
        </View>
      </View>
    );
  }

  const date = new Date(item.date * 1000).toLocaleString();

  return (
    <Portal>
      <View
        style={[
          styles.overlay,
          { paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.bar}>
          <IconButton icon="close" iconColor="#fff" onPress={onClose} />
          <View style={styles.titleBox}>
            <Text numberOfLines={1} style={styles.title}>
              {item.name}
            </Text>
            <Text numberOfLines={1} style={styles.subtitle}>
              {formatSize(item.size)} · {date}
              {item.encrypted ? ' · encrypted' : ''}
            </Text>
          </View>
          {item.kind !== 'message' && (
            <>
              <IconButton
                icon="open-in-new"
                iconColor="#fff"
                disabled={!path}
                onPress={() => setOpenWithVisible(true)}
              />
              <IconButton
                icon="download"
                iconColor="#fff"
                disabled={saving}
                onPress={() => {
                  void onSave();
                }}
              />
            </>
          )}
        </View>

        <View style={styles.fill}>{body}</View>

        {item.text.length > 0 && item.kind !== 'message' && (
          <Text style={styles.caption} numberOfLines={4} selectable>
            {item.text}
          </Text>
        )}
        <View style={styles.bottom}>
          <IconButton
            icon="chevron-left"
            iconColor="#fff"
            disabled={index === 0}
            onPress={() => go('prev')}
          />
          <Text style={styles.dim}>
            {index + 1} / {items.length}
          </Text>
          <IconButton
            icon="chevron-right"
            iconColor="#fff"
            disabled={index >= items.length - 1}
            onPress={() => go('next')}
          />
        </View>
      </View>

      <PassphraseDialog
        visible={ask !== null}
        wrong={ask?.wrong ?? false}
        onDismiss={() => setAsk(null)}
        onSubmit={passphrase => {
          setAsk(null);
          void load(item, passphrase);
        }}
      />

      <Dialog
        visible={openWithVisible}
        onDismiss={() => setOpenWithVisible(false)}
      >
        <Dialog.Title>Open in another app?</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodySmall">
            The other app receives the {item.encrypted ? 'decrypted ' : ''}
            file and may keep its own copy, outside the Vault's lock.
          </Text>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={() => setOpenWithVisible(false)}>Cancel</Button>
          <Button
            mode="contained"
            onPress={() => {
              void onOpenWith();
            }}
          >
            Open
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#000',
  },
  fill: { flex: 1 },
  bar: { flexDirection: 'row', alignItems: 'center' },
  titleBox: { flex: 1 },
  title: { color: '#fff', fontSize: 16, fontWeight: '600' },
  subtitle: { color: '#aaa', fontSize: 12 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  light: { color: '#fff', textAlign: 'center' },
  dim: { color: '#aaa', textAlign: 'center' },
  progress: { width: 240, height: 6, borderRadius: 3 },
  audio: { height: 80, width: '100%' },
  row: { flexDirection: 'row', gap: 12 },
  caption: {
    color: '#ddd',
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  FlatList,
  Image,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import {
  ActivityIndicator,
  Button,
  Chip,
  Dialog,
  Icon,
  IconButton,
  Portal,
  RadioButton,
  Searchbar,
  Snackbar,
  Switch,
  Text,
  TouchableRipple,
  useTheme,
} from 'react-native-paper';

import { useAppStore } from '../../state/store';
import { configRepo } from '../../services/db/schema';
import { listTopics, GENERAL_TOPIC_ID } from '../../services/telegram/topics';
import {
  clearVaultCache,
  fetchThumb,
  listTopicPage,
  saveVaultItem,
  type VaultItem,
  type VaultKind,
} from '../../services/telegram/browse';
import { VaultPassphraseRequiredError } from '../../services/crypto/vault';
import { appLock, type LockSettings } from '../../services/secure/applock';
import { setSecureWindow } from '../../services/vault/native';
import { describeError } from '../../utils/logger';
import type { RemoteTopic } from '../../types';
import { AUTO_LOCK_CHOICES, useVaultSession } from './session';
import { LockScreen, LockSetup } from './LockScreens';
import PassphraseDialog from './PassphraseDialog';
import ViewerOverlay, { formatSize, KIND_ICON } from './ViewerOverlay';

const LOCK_SKIPPED_KEY = 'vault_lock_skipped';
const COLUMNS = 3;
/** Pages fetched on their own to fill a sparse filter. */
const MAX_AUTO_PAGES = 6;

type Filter = 'all' | 'photos' | 'videos' | 'audio' | 'docs' | 'text';

const FILTERS: { value: Filter; label: string; kinds: VaultKind[] }[] = [
  { value: 'all', label: 'All', kinds: [] },
  { value: 'photos', label: 'Photos', kinds: ['image'] },
  { value: 'videos', label: 'Videos', kinds: ['video'] },
  { value: 'audio', label: 'Audio', kinds: ['audio'] },
  { value: 'docs', label: 'Docs', kinds: ['pdf', 'archive', 'other'] },
  { value: 'text', label: 'Text', kinds: ['text', 'message'] },
];

/* ------------------------------------------------------------- thumbnails */

/** Few at a time: a fast scroll must not fire hundreds of downloads at once. */
const MAX_THUMB_JOBS = 3;
let runningThumbs = 0;
const thumbQueue: (() => void)[] = [];

function queueThumb<T>(job: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const run = () => {
      runningThumbs += 1;
      job()
        .then(resolve, reject)
        .finally(() => {
          runningThumbs -= 1;
          thumbQueue.shift()?.();
        });
    };
    if (runningThumbs < MAX_THUMB_JOBS) {
      run();
    } else {
      thumbQueue.push(run);
    }
  });
}

function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function Tile({
  item,
  size,
  selected,
  selecting,
  onPress,
  onLongPress,
}: {
  item: VaultItem;
  size: number;
  selected: boolean;
  selecting: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const theme = useTheme();
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    if (item.hasThumb) {
      void queueThumb(() => (alive ? fetchThumb(item) : Promise.resolve(null)))
        .then(path => alive && path && setThumb(`file://${path}`))
        .catch(() => undefined);
    }
    return () => {
      alive = false;
    };
  }, [item]);

  return (
    <TouchableRipple
      onPress={onPress}
      onLongPress={onLongPress}
      style={[
        styles.tile,
        {
          width: size,
          height: size,
          backgroundColor: theme.colors.surfaceVariant,
        },
      ]}
    >
      <View style={styles.tileInner}>
        {thumb ? (
          <Image source={{ uri: thumb }} style={styles.thumb} />
        ) : (
          <View style={styles.tileIcon}>
            <Icon source={KIND_ICON[item.kind]} size={32} />
            <Text numberOfLines={2} style={styles.tileName}>
              {item.name}
            </Text>
            {item.kind !== 'message' && (
              <Text style={styles.tileSize}>{formatSize(item.size)}</Text>
            )}
          </View>
        )}
        <View style={styles.badges}>
          {item.encrypted && (
            <View style={styles.badge}>
              <Icon source="lock" size={12} color="#fff" />
            </View>
          )}
          {item.duration !== null && item.duration > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {formatDuration(item.duration)}
              </Text>
            </View>
          )}
        </View>
        {selecting && (
          <View style={[styles.check, selected && styles.checkOn]}>
            {selected && <Icon source="check" size={16} color="#fff" />}
          </View>
        )}
      </View>
    </TouchableRipple>
  );
}

/* ----------------------------------------------------------------- screen */

/**
 * Browse the backup channel as it is on Telegram: every file in every topic,
 * decrypting `.tgbk` files for viewing. Unlike the Restore tab this does not
 * depend on this phone's index, so it works on a new phone too.
 */
export default function VaultScreen(): React.JSX.Element {
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const localTopics = useAppStore(state => state.topics);

  const unlocked = useVaultSession(state => state.unlocked);
  const unlock = useVaultSession(state => state.unlock);
  const lock = useVaultSession(state => state.lock);

  /** undefined while loading; null when no lock is set. */
  const [lockSettings, setLockSettings] = useState<
    LockSettings | null | undefined
  >(undefined);
  const [skipped, setSkipped] = useState(false);
  const [flow, setFlow] = useState<
    null | 'setup' | 'verify-change' | 'change' | 'verify-remove'
  >(null);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [biometryType, setBiometryType] = useState<string | null>(null);

  const [topics, setTopics] = useState<RemoteTopic[]>([]);
  const [topicId, setTopicId] = useState<number | null>(null);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [bulkAsk, setBulkAsk] = useState<{ wrong: boolean } | null>(null);
  const bulkResume = useRef<((passphrase: string | null) => void) | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const loadToken = useRef(0);

  const autoLock = lockSettings?.autoLockSeconds ?? 0;
  const selecting = selected.size > 0;

  const refreshLock = useCallback(async () => {
    const [settings, skippedValue, bio] = await Promise.all([
      appLock.settings(),
      configRepo.getValue(LOCK_SKIPPED_KEY),
      appLock.biometryType(),
    ]);
    setLockSettings(settings);
    setSkipped(skippedValue === '1');
    setBiometryType(bio);
  }, []);

  useEffect(() => {
    void refreshLock();
    // Leftovers from a run that was killed before it could lock.
    if (!useVaultSession.getState().unlocked) {
      void clearVaultCache();
    }
  }, [refreshLock]);

  /* ---------------------------------------------------- auto-lock & secure */

  // Read through a ref: if the effects below depended on the setting itself,
  // changing it would re-run them, count as leaving, and lock on the spot.
  const autoLockRef = useRef(autoLock);
  autoLockRef.current = autoLock;

  const focused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void setSecureWindow(true);
      void useVaultSession.getState().checkReturn(autoLockRef.current);
      return () => {
        focused.current = false;
        void setSecureWindow(false);
        useVaultSession.getState().markLeft();
      };
    }, []),
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (!focused.current) {
        return;
      }
      if (state === 'background') {
        useVaultSession.getState().markLeft();
      } else if (state === 'active') {
        void useVaultSession.getState().checkReturn(autoLockRef.current);
      }
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!unlocked) {
      setViewIndex(null);
      setSelected(new Set());
    }
  }, [unlocked]);

  const open = lockSettings === null ? skipped : unlocked;
  const browsing = lockSettings !== undefined && open && flow === null;

  useEffect(() => {
    navigation.setOptions({
      headerRight: () =>
        browsing ? (
          <View style={styles.headerActions}>
            {lockSettings && (
              <IconButton
                icon="lock-outline"
                onPress={() => {
                  void lock();
                }}
              />
            )}
            <IconButton
              icon="cog-outline"
              onPress={() => setSettingsVisible(true)}
            />
          </View>
        ) : null,
    });
  }, [navigation, browsing, lockSettings, lock]);

  /* ------------------------------------------------------------ browsing */

  useEffect(() => {
    if (!browsing || topics.length > 0) {
      return;
    }
    // Local titles first so the picker is instant, then the live list.
    const local = localTopics.map(topic => ({
      id: topic.topic_id,
      title: topic.title,
      closed: false,
      isGeneral: topic.topic_id === GENERAL_TOPIC_ID,
    }));
    if (local.length > 0) {
      setTopics(local);
    }
    listTopics()
      .then(remote => setTopics(remote))
      .catch(error => {
        if (local.length === 0) {
          setMessage(describeError(error));
        }
      });
  }, [browsing, topics.length, localTopics]);

  useEffect(() => {
    if (topicId === null && topics.length > 0) {
      // Prefer a real topic over General, which is usually empty here.
      setTopicId((topics.find(topic => !topic.isGeneral) ?? topics[0]).id);
    }
  }, [topics, topicId]);

  const loadFirst = useCallback(async () => {
    if (topicId === null) {
      return;
    }
    const token = ++loadToken.current;
    setLoading(true);
    setItems([]);
    setNextOffset(null);
    try {
      const page = await listTopicPage(topicId, 0, query);
      if (token === loadToken.current) {
        setItems(page.items);
        setNextOffset(page.nextOffsetId);
      }
    } catch (error) {
      if (token === loadToken.current) {
        setMessage(describeError(error));
      }
    } finally {
      if (token === loadToken.current) {
        setLoading(false);
      }
    }
  }, [topicId, query]);

  useEffect(() => {
    if (browsing) {
      void loadFirst();
    }
  }, [browsing, loadFirst]);

  const loadMore = useCallback(async () => {
    if (topicId === null || nextOffset === null || loading || loadingMore) {
      return;
    }
    const token = loadToken.current;
    setLoadingMore(true);
    try {
      const page = await listTopicPage(topicId, nextOffset, query);
      if (token === loadToken.current) {
        setItems(current => {
          const seen = new Set(current.map(item => item.key));
          return [
            ...current,
            ...page.items.filter(item => !seen.has(item.key)),
          ];
        });
        setNextOffset(page.nextOffsetId);
      }
    } catch (error) {
      setMessage(describeError(error));
    } finally {
      setLoadingMore(false);
    }
  }, [topicId, nextOffset, query, loading, loadingMore]);

  const visible = useMemo(() => {
    const kinds = FILTERS.find(entry => entry.value === filter)?.kinds ?? [];
    return kinds.length === 0
      ? items
      : items.filter(item => kinds.includes(item.kind));
  }, [items, filter]);

  // A narrow filter can leave the loaded pages with few matches: keep paging,
  // but only so far. A filter with no matches at all must not walk a 30k-item
  // topic and run into FLOOD_WAIT; scrolling or search reaches the rest.
  const autoPages = useRef(0);
  useEffect(() => {
    autoPages.current = 0;
  }, [filter, topicId, query]);
  useEffect(() => {
    if (
      browsing &&
      !loading &&
      !loadingMore &&
      visible.length < 30 &&
      nextOffset !== null &&
      autoPages.current < MAX_AUTO_PAGES
    ) {
      autoPages.current += 1;
      void loadMore();
    }
  }, [browsing, loading, loadingMore, visible.length, nextOffset, loadMore]);

  const topicTitle =
    topics.find(topic => topic.id === topicId)?.title ?? 'Vault';

  const toggle = useCallback((key: string) => {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  /** Saves the selection one by one; pauses once to ask for a passphrase. */
  const saveSelected = useCallback(async () => {
    const chosen = items.filter(item => selected.has(item.key));
    setSelected(new Set());
    setBulk({ done: 0, total: chosen.length });
    let failed = 0;
    for (let i = 0; i < chosen.length; i += 1) {
      const item = chosen[i];
      let passphrase: string | undefined;
      for (;;) {
        try {
          await saveVaultItem(item, topicTitle, { passphrase });
          break;
        } catch (error) {
          if (error instanceof VaultPassphraseRequiredError) {
            setBulkAsk({ wrong: error.wrongPassphrase });
            const entered = await new Promise<string | null>(resolve => {
              bulkResume.current = resolve;
            });
            if (entered === null) {
              setBulk(null);
              setMessage(`Stopped. Saved ${i} of ${chosen.length}.`);
              return;
            }
            passphrase = entered;
            continue;
          }
          failed += 1;
          break;
        }
      }
      setBulk({ done: i + 1, total: chosen.length });
    }
    setBulk(null);
    setMessage(
      `Saved ${chosen.length - failed} of ${chosen.length} to Download/TeleSync/${topicTitle}` +
        (failed > 0 ? ` (${failed} failed, see Logs)` : ''),
    );
  }, [items, selected, topicTitle]);

  /* ------------------------------------------------------------- render */

  if (lockSettings === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (flow === 'setup' || flow === 'change') {
    return (
      <LockSetup
        initial={lockSettings}
        cancelLabel="Cancel"
        onCancel={() => setFlow(null)}
        onDone={() => {
          setFlow(null);
          unlock();
          void refreshLock();
          setMessage('Vault lock set');
        }}
      />
    );
  }

  if ((flow === 'verify-change' || flow === 'verify-remove') && lockSettings) {
    return (
      <LockScreen
        settings={lockSettings}
        title={
          flow === 'verify-change'
            ? 'Confirm it is you to change the lock'
            : 'Confirm it is you to remove the lock'
        }
        allowBiometrics={false}
        onCancel={() => setFlow(null)}
        onUnlocked={() => {
          if (flow === 'verify-change') {
            setFlow('change');
          } else {
            setFlow(null);
            void appLock.remove().then(async () => {
              await configRepo.setValue(LOCK_SKIPPED_KEY, '1');
              await refreshLock();
              setMessage('Vault lock removed');
            });
          }
        }}
      />
    );
  }

  if (lockSettings === null && !skipped) {
    return (
      <LockSetup
        onDone={() => {
          unlock();
          void refreshLock();
        }}
        onCancel={() => {
          void configRepo.setValue(LOCK_SKIPPED_KEY, '1').then(refreshLock);
        }}
      />
    );
  }

  if (lockSettings && !unlocked) {
    return (
      <LockScreen
        settings={lockSettings}
        onUnlocked={unlock}
        onReset={() => {
          void configRepo.setValue(LOCK_SKIPPED_KEY, '0').then(refreshLock);
        }}
      />
    );
  }

  const tileSize = Math.floor((width - 8) / COLUMNS) - 4;

  return (
    <View style={styles.fill}>
      <FlatList
        data={visible}
        key={`grid-${COLUMNS}`}
        numColumns={COLUMNS}
        keyExtractor={item => item.key}
        contentContainerStyle={styles.grid}
        refreshing={loading}
        onRefresh={() => {
          void loadFirst();
        }}
        onEndReached={() => {
          void loadMore();
        }}
        onEndReachedThreshold={0.6}
        ListHeaderComponent={
          <View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              {topics.map(topic => (
                <Chip
                  key={topic.id}
                  selected={topic.id === topicId}
                  showSelectedOverlay
                  onPress={() => {
                    setSelected(new Set());
                    setTopicId(topic.id);
                  }}
                >
                  {topic.title}
                </Chip>
              ))}
            </ScrollView>
            <Searchbar
              placeholder={`Search ${topicTitle}`}
              value={queryInput}
              onChangeText={text => {
                setQueryInput(text);
                if (text.length === 0) {
                  setQuery('');
                }
              }}
              onSubmitEditing={() => setQuery(queryInput)}
              onClearIconPress={() => setQuery('')}
              style={styles.search}
            />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.chips}
            >
              {FILTERS.map(entry => (
                <Chip
                  key={entry.value}
                  compact
                  mode="outlined"
                  selected={entry.value === filter}
                  onPress={() => setFilter(entry.value)}
                >
                  {entry.label}
                </Chip>
              ))}
            </ScrollView>
            {selecting && (
              <View style={styles.selectBar}>
                <Text variant="titleSmall">{selected.size} selected</Text>
                <View style={styles.row}>
                  <Button
                    onPress={() =>
                      setSelected(new Set(visible.map(i => i.key)))
                    }
                  >
                    All loaded
                  </Button>
                  <Button onPress={() => setSelected(new Set())}>Clear</Button>
                  <Button
                    mode="contained"
                    icon="download"
                    onPress={() => {
                      void saveSelected();
                    }}
                  >
                    Save
                  </Button>
                </View>
              </View>
            )}
          </View>
        }
        ListEmptyComponent={
          loading ? undefined : (
            <Text variant="bodyMedium" style={styles.empty}>
              {topics.length === 0
                ? 'No topics yet. Check the channel in Settings and the Topics tab.'
                : query
                  ? 'Nothing matches that search.'
                  : 'Nothing here yet.'}
            </Text>
          )
        }
        ListFooterComponent={
          loadingMore ? <ActivityIndicator style={styles.footer} /> : undefined
        }
        renderItem={({ item }) => (
          <Tile
            item={item}
            size={tileSize}
            selecting={selecting}
            selected={selected.has(item.key)}
            onPress={() => {
              if (selecting) {
                toggle(item.key);
              } else {
                setViewIndex(visible.indexOf(item));
              }
            }}
            onLongPress={() => toggle(item.key)}
          />
        )}
      />

      {viewIndex !== null && visible[viewIndex] && (
        <ViewerOverlay
          items={visible}
          index={viewIndex}
          topicTitle={topicTitle}
          onIndexChange={next => {
            setViewIndex(next);
            if (next >= visible.length - 5) {
              void loadMore();
            }
          }}
          onClose={() => setViewIndex(null)}
          onMessage={setMessage}
        />
      )}

      <PassphraseDialog
        visible={bulkAsk !== null}
        wrong={bulkAsk?.wrong ?? false}
        onDismiss={() => {
          setBulkAsk(null);
          bulkResume.current?.(null);
        }}
        onSubmit={passphrase => {
          setBulkAsk(null);
          bulkResume.current?.(passphrase);
        }}
      />

      <Portal>
        <Dialog
          visible={settingsVisible}
          onDismiss={() => setSettingsVisible(false)}
        >
          <Dialog.Title>Vault settings</Dialog.Title>
          <Dialog.ScrollArea>
            <ScrollView contentContainerStyle={styles.settings}>
              {lockSettings ? (
                <>
                  <Text variant="labelLarge">Lock again</Text>
                  <RadioButton.Group
                    value={String(lockSettings.autoLockSeconds)}
                    onValueChange={value => {
                      void appLock
                        .updateSettings({ autoLockSeconds: Number(value) })
                        .then(refreshLock);
                    }}
                  >
                    {AUTO_LOCK_CHOICES.map(choice => (
                      <RadioButton.Item
                        key={choice.seconds}
                        label={choice.label}
                        value={String(choice.seconds)}
                      />
                    ))}
                  </RadioButton.Group>
                  {biometryType && (
                    <View style={styles.switchRow}>
                      <Text>Fingerprint / face unlock</Text>
                      <Switch
                        value={lockSettings.biometrics}
                        onValueChange={enabled => {
                          const change = enabled
                            ? (useVaultSession.getState().expectLeave(),
                              appLock.enableBiometrics())
                            : appLock.disableBiometrics();
                          void change
                            .then(refreshLock)
                            .catch(error => setMessage(describeError(error)));
                        }}
                      />
                    </View>
                  )}
                  <Button
                    style={styles.settingsButton}
                    onPress={() => {
                      setSettingsVisible(false);
                      setFlow('verify-change');
                    }}
                  >
                    Change {lockSettings.method === 'pin' ? 'PIN' : 'password'}
                  </Button>
                  <Button
                    style={styles.settingsButton}
                    textColor="#E5484D"
                    onPress={() => {
                      setSettingsVisible(false);
                      setFlow('verify-remove');
                    }}
                  >
                    Remove lock
                  </Button>
                </>
              ) : (
                <>
                  <Text variant="bodySmall">
                    The Vault is not locked. Anyone holding your unlocked phone
                    can browse and decrypt it.
                  </Text>
                  <Button
                    mode="contained"
                    style={styles.settingsButton}
                    onPress={() => {
                      setSettingsVisible(false);
                      setFlow('setup');
                    }}
                  >
                    Set up a lock
                  </Button>
                </>
              )}
              <Button
                style={styles.settingsButton}
                onPress={() => {
                  void clearVaultCache().then(() =>
                    setMessage('Decrypted files cleared from this phone'),
                  );
                }}
              >
                Clear decrypted files now
              </Button>
            </ScrollView>
          </Dialog.ScrollArea>
          <Dialog.Actions>
            <Button onPress={() => setSettingsVisible(false)}>Done</Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>

      <Snackbar
        visible={message !== null || bulk !== null}
        onDismiss={() => setMessage(null)}
        duration={bulk ? 1_000_000 : 5000}
      >
        {bulk ? `Saving ${bulk.done} of ${bulk.total}…` : (message ?? '')}
      </Snackbar>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  grid: { padding: 4, paddingBottom: 32 },
  chips: { gap: 8, paddingHorizontal: 4, paddingVertical: 6 },
  search: { marginHorizontal: 4, marginVertical: 4 },
  selectBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexWrap: 'wrap',
  },
  row: { flexDirection: 'row', gap: 4 },
  empty: { textAlign: 'center', marginTop: 48, opacity: 0.6, padding: 16 },
  footer: { marginVertical: 16 },
  tile: { margin: 2, borderRadius: 6, overflow: 'hidden' },
  tileInner: { flex: 1 },
  thumb: { width: '100%', height: '100%' },
  tileIcon: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 6,
    gap: 4,
  },
  tileName: { fontSize: 11, textAlign: 'center' },
  tileSize: { fontSize: 10, opacity: 0.6 },
  badges: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    flexDirection: 'row',
    gap: 4,
  },
  badge: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 2,
    flexDirection: 'row',
    alignItems: 'center',
  },
  badgeText: { color: '#fff', fontSize: 10 },
  check: {
    position: 'absolute',
    top: 6,
    left: 6,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  checkOn: { backgroundColor: '#2AABEE', borderColor: '#2AABEE' },
  headerActions: { flexDirection: 'row' },
  settings: { paddingVertical: 12 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  settingsButton: { marginTop: 8 },
});

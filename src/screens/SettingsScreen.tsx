import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  Button,
  Card,
  Dialog,
  Divider,
  Portal,
  Snackbar,
  Switch,
  Text,
  TextInput,
} from 'react-native-paper';

import { useAppStore } from '../state/store';
import { filesRepo } from '../services/db/schema';
import { logout } from '../services/telegram/client';
import { vault } from '../services/crypto/vault';
import { clearPreviewCache } from '../services/telegram/download';
import { cancelScheduledSync, scheduleSync } from '../background/scheduler';
import { describeError } from '../utils/logger';

/** Parses a numeric field, falling back to the previous value when unusable. */
function parseNumber(value: string, fallback: number): number {
  const parsed = Number(value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default function SettingsScreen(): React.JSX.Element {
  const { config, saveConfig, refreshAuth, refreshCounts } = useAppStore();
  const [message, setMessage] = useState<string | null>(null);
  const [clearVisible, setClearVisible] = useState(false);
  const [logoutVisible, setLogoutVisible] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [vaultReady, setVaultReady] = useState(false);

  // Local draft state: committing on every keystroke would rewrite the Keychain
  // and reschedule WorkManager far too often.
  const [apiId, setApiId] = useState(config.apiId ? String(config.apiId) : '');
  const [apiHash, setApiHash] = useState(config.apiHash);
  const [channelId, setChannelId] = useState(config.channelId);
  const [throttle, setThrottle] = useState(String(config.throttleSeconds));
  const [maxFileMb, setMaxFileMb] = useState(String(config.maxFileMb));
  const [interval, setInterval] = useState(String(config.syncIntervalHours));
  const [extensions, setExtensions] = useState(config.extensions.join(', '));
  const [rootTopic, setRootTopic] = useState(
    config.rootTopicId ? String(config.rootTopicId) : '',
  );

  useEffect(() => {
    void vault.isUnlocked().then(setVaultReady);
  }, []);

  const onSetPassphrase = useCallback(async () => {
    if (passphrase !== passphrase2) {
      setMessage('The two passphrases do not match.');
      return;
    }
    try {
      await vault.setPassphrase(passphrase);
      setPassphrase('');
      setPassphrase2('');
      setVaultReady(true);
      setMessage('Encryption passphrase saved');
    } catch (error) {
      setMessage(describeError(error));
    }
  }, [passphrase, passphrase2]);

  const onSave = useCallback(async () => {
    try {
      await saveConfig({
        apiId: Math.trunc(parseNumber(apiId, config.apiId)),
        apiHash: apiHash.trim(),
        channelId: channelId.trim(),
        throttleSeconds: parseNumber(throttle, config.throttleSeconds),
        maxFileMb: parseNumber(maxFileMb, config.maxFileMb),
        syncIntervalHours: parseNumber(interval, config.syncIntervalHours),
        extensions: extensions
          .split(',')
          .map(part => part.trim().replace(/^\./, '').toLowerCase())
          .filter(Boolean),
        rootTopicId: rootTopic.trim()
          ? Math.trunc(parseNumber(rootTopic, 0))
          : null,
      });
      setMessage('Settings saved');
    } catch (error) {
      setMessage(describeError(error));
    }
  }, [
    apiId,
    apiHash,
    channelId,
    throttle,
    maxFileMb,
    interval,
    extensions,
    rootTopic,
    config,
    saveConfig,
  ]);

  const onToggle = useCallback(
    async (patch: Parameters<typeof saveConfig>[0]) => {
      try {
        await saveConfig(patch);
      } catch (error) {
        setMessage(describeError(error));
      }
    },
    [saveConfig],
  );

  return (
    <>
      <ScrollView contentContainerStyle={styles.container}>
        <Card mode="outlined" style={styles.card}>
          <Card.Title title="Telegram API" subtitle="From my.telegram.org" />
          <Card.Content>
            <TextInput
              label="API ID"
              value={apiId}
              onChangeText={setApiId}
              mode="outlined"
              keyboardType="number-pad"
              style={styles.input}
            />
            <TextInput
              label="API hash"
              value={apiHash}
              onChangeText={setApiHash}
              mode="outlined"
              secureTextEntry
              style={styles.input}
            />
            <Text variant="bodySmall" style={styles.dim}>
              Stored in the Android Keystore, never in plain storage.
            </Text>
            <TextInput
              label="Channel ID"
              value={channelId}
              onChangeText={setChannelId}
              mode="outlined"
              placeholder="-1001234567890"
              style={styles.input}
            />
          </Card.Content>
        </Card>

        <Card mode="outlined" style={styles.card}>
          <Card.Title title="Uploads" />
          <Card.Content>
            <TextInput
              label="Throttle between uploads (seconds)"
              value={throttle}
              onChangeText={setThrottle}
              mode="outlined"
              keyboardType="number-pad"
              style={styles.input}
            />
            <TextInput
              label="Max file size (MB)"
              value={maxFileMb}
              onChangeText={setMaxFileMb}
              mode="outlined"
              keyboardType="number-pad"
              style={styles.input}
            />
            <Text variant="bodySmall" style={styles.dim}>
              2000 for a free account, 4000 with Telegram Premium.
            </Text>
            <TextInput
              label="Extensions to include (blank = all)"
              value={extensions}
              onChangeText={setExtensions}
              mode="outlined"
              placeholder="jpg, mp4, pdf"
              style={styles.input}
            />
            <TextInput
              label="Root topic ID (blank = channel root)"
              value={rootTopic}
              onChangeText={setRootTopic}
              mode="outlined"
              keyboardType="number-pad"
              style={styles.input}
            />

            <View style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text variant="bodyMedium">Back up all photos and videos</Text>
                <Text variant="bodySmall" style={styles.dim}>
                  Sweeps the whole media library on top of your bound folders.
                  Off by default, so a sync only reads folders you chose.
                </Text>
              </View>
              <Switch
                value={config.backupAllMedia}
                onValueChange={value => {
                  void onToggle({ backupAllMedia: value });
                }}
              />
            </View>

            <View style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text variant="bodyMedium">Send as document</Text>
                <Text variant="bodySmall" style={styles.dim}>
                  Keeps originals byte-identical instead of letting Telegram
                  re-encode them.
                </Text>
              </View>
              <Switch
                value={config.asDocument}
                onValueChange={value => {
                  void onToggle({ asDocument: value });
                }}
              />
            </View>
          </Card.Content>
        </Card>

        <Card mode="outlined" style={styles.card}>
          <Card.Title title="Schedule" />
          <Card.Content>
            <TextInput
              label="Sync interval (hours)"
              value={interval}
              onChangeText={setInterval}
              mode="outlined"
              keyboardType="number-pad"
              style={styles.input}
            />

            <View style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text variant="bodyMedium">Wi-Fi only</Text>
              </View>
              <Switch
                value={config.wifiOnly}
                onValueChange={value => {
                  void onToggle({ wifiOnly: value });
                }}
              />
            </View>

            <View style={styles.switchRow}>
              <View style={styles.switchLabel}>
                <Text variant="bodyMedium">Only while charging</Text>
              </View>
              <Switch
                value={config.requiresCharging}
                onValueChange={value => {
                  void onToggle({ requiresCharging: value });
                }}
              />
            </View>
          </Card.Content>
          <Card.Actions>
            <Button
              onPress={() => {
                void scheduleSync()
                  .then(() => setMessage('Schedule updated'))
                  .catch(error => setMessage(describeError(error)));
              }}
            >
              Reschedule
            </Button>
            <Button
              onPress={() => {
                void cancelScheduledSync()
                  .then(() => setMessage('Schedule cancelled'))
                  .catch(error => setMessage(describeError(error)));
              }}
            >
              Cancel schedule
            </Button>
          </Card.Actions>
        </Card>

        <Button mode="contained" onPress={onSave} style={styles.save}>
          Save settings
        </Button>

        <Divider style={styles.divider} />

        <Card mode="outlined" style={styles.card}>
          <Card.Title
            title="Encryption"
            subtitle={vaultReady ? 'Passphrase set' : 'No passphrase yet'}
          />
          <Card.Content>
            <Text variant="bodySmall" style={styles.dim}>
              Turn encryption on per folder, on the Folders tab. Files are
              encrypted with AES-256-GCM before upload, so Telegram only ever
              stores ciphertext. The key never leaves this device.
            </Text>
            <Text variant="bodySmall" style={styles.warn}>
              There is no recovery. If you forget this passphrase, every
              encrypted file in the backup is permanently unreadable. Write it
              down somewhere safe.
            </Text>
            <TextInput
              label="Passphrase"
              value={passphrase}
              onChangeText={setPassphrase}
              mode="outlined"
              secureTextEntry
              style={styles.input}
            />
            <TextInput
              label="Repeat passphrase"
              value={passphrase2}
              onChangeText={setPassphrase2}
              mode="outlined"
              secureTextEntry
              style={styles.input}
            />
            <Text variant="bodySmall" style={styles.dim}>
              Enter the same passphrase on another device to restore encrypted
              files there.
            </Text>
          </Card.Content>
          <Card.Actions style={styles.dangerActions}>
            <Button
              mode="contained"
              disabled={passphrase.length < 8}
              onPress={onSetPassphrase}
            >
              Save passphrase
            </Button>
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

        <Card mode="outlined" style={styles.card}>
          <Card.Title title="Account and data" />
          <Card.Actions style={styles.dangerActions}>
            <Button onPress={() => setLogoutVisible(true)}>Re-login</Button>
            <Button textColor="#B3261E" onPress={() => setClearVisible(true)}>
              Clear local DB
            </Button>
          </Card.Actions>
        </Card>
      </ScrollView>

      <Portal>
        <Dialog visible={clearVisible} onDismiss={() => setClearVisible(false)}>
          <Dialog.Title>Clear local index?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              This wipes the record of what has already been uploaded. Nothing
              is deleted from Telegram — but the next sync will re-upload
              everything, creating duplicates in the channel.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setClearVisible(false)}>Cancel</Button>
            <Button
              textColor="#B3261E"
              onPress={() => {
                setClearVisible(false);
                void filesRepo
                  .clearAll()
                  .then(refreshCounts)
                  .then(() => setMessage('Local index cleared'))
                  .catch(error => setMessage(describeError(error)));
              }}
            >
              Clear
            </Button>
          </Dialog.Actions>
        </Dialog>

        <Dialog
          visible={logoutVisible}
          onDismiss={() => setLogoutVisible(false)}
        >
          <Dialog.Title>Sign out?</Dialog.Title>
          <Dialog.Content>
            <Text variant="bodyMedium">
              Ends the Telegram session on this device. Your backup and local
              index stay intact.
            </Text>
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setLogoutVisible(false)}>Cancel</Button>
            <Button
              onPress={() => {
                setLogoutVisible(false);
                void logout()
                  .then(refreshAuth)
                  .then(() => setMessage('Signed out'))
                  .catch(error => setMessage(describeError(error)));
              }}
            >
              Sign out
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
  container: { padding: 16, paddingBottom: 48 },
  card: { marginBottom: 16 },
  input: { marginBottom: 10 },
  dim: { opacity: 0.7, marginBottom: 10 },
  warn: { color: '#B3261E', marginBottom: 10 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  switchLabel: { flex: 1, paddingRight: 16 },
  save: { marginBottom: 16 },
  divider: { marginVertical: 8 },
  dangerActions: { justifyContent: 'flex-start', gap: 8 },
});

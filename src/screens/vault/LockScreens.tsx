import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import {
  Button,
  Checkbox,
  Dialog,
  HelperText,
  Icon,
  Portal,
  RadioButton,
  SegmentedButtons,
  Text,
  TextInput,
  TouchableRipple,
  useTheme,
} from 'react-native-paper';

import {
  appLock,
  MIN_PASSWORD_LENGTH,
  MIN_PIN_LENGTH,
  type LockMethod,
  type LockSettings,
} from '../../services/secure/applock';
import { vault } from '../../services/crypto/vault';
import { describeError } from '../../utils/logger';
import { AUTO_LOCK_CHOICES, useVaultSession } from './session';

const MAX_PIN_LENGTH = 8;

/* --------------------------------------------------------------- PIN pad */

function Dots({ count, max }: { count: number; max: number }) {
  const theme = useTheme();
  return (
    <View style={styles.dots}>
      {Array.from({ length: Math.max(count, max) }).map((_, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            { borderColor: theme.colors.primary },
            i < count && { backgroundColor: theme.colors.primary },
          ]}
        />
      ))}
    </View>
  );
}

function PinPad({
  value,
  onChange,
  onSubmit,
  disabled,
  leftKey,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  disabled?: boolean;
  /** Bottom-left key, e.g. the fingerprint button. */
  leftKey?: React.ReactNode;
}) {
  const press = (digit: string) => {
    if (!disabled && value.length < MAX_PIN_LENGTH) {
      onChange(value + digit);
    }
  };
  const key = (label: string) => (
    <TouchableRipple
      key={label}
      borderless
      style={styles.key}
      disabled={disabled}
      onPress={() => press(label)}
    >
      <Text variant="headlineMedium">{label}</Text>
    </TouchableRipple>
  );
  return (
    <View style={styles.pad}>
      {[
        ['1', '2', '3'],
        ['4', '5', '6'],
        ['7', '8', '9'],
      ].map(row => (
        <View key={row.join()} style={styles.padRow}>
          {row.map(key)}
        </View>
      ))}
      <View style={styles.padRow}>
        <View style={styles.key}>{leftKey}</View>
        {key('0')}
        <TouchableRipple
          borderless
          style={styles.key}
          disabled={disabled}
          onPress={() => onChange(value.slice(0, -1))}
          onLongPress={() => onChange('')}
        >
          <Icon source="backspace-outline" size={26} />
        </TouchableRipple>
      </View>
      {onSubmit && (
        <Button
          mode="contained"
          style={styles.padSubmit}
          disabled={disabled || value.length < MIN_PIN_LENGTH}
          onPress={onSubmit}
        >
          Unlock
        </Button>
      )}
    </View>
  );
}

/* ----------------------------------------------------------------- setup */

/**
 * Choosing a PIN or password. Used for first setup and for changing it; the
 * caller is responsible for having verified the old one before a change.
 */
export function LockSetup({
  initial,
  onDone,
  onCancel,
  cancelLabel = 'Not now',
}: {
  initial?: LockSettings | null;
  onDone: () => void;
  onCancel: () => void;
  cancelLabel?: string;
}): React.JSX.Element {
  const [method, setMethod] = useState<LockMethod>(initial?.method ?? 'pin');
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [first, setFirst] = useState('');
  const [second, setSecond] = useState('');
  const [autoLock, setAutoLock] = useState(initial?.autoLockSeconds ?? 0);
  const [biometryType, setBiometryType] = useState<string | null>(null);
  const [useBiometrics, setUseBiometrics] = useState(
    initial?.biometrics ?? true,
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void appLock.biometryType().then(setBiometryType);
  }, []);

  const min = method === 'pin' ? MIN_PIN_LENGTH : MIN_PASSWORD_LENGTH;
  const current = step === 'enter' ? first : second;
  const setCurrent = step === 'enter' ? setFirst : setSecond;

  const reset = (next: LockMethod) => {
    setMethod(next);
    setStep('enter');
    setFirst('');
    setSecond('');
    setError(null);
  };

  const next = useCallback(async () => {
    if (step === 'enter') {
      if (first.length < min) {
        setError(
          `Use at least ${min} ${method === 'pin' ? 'digits' : 'characters'}.`,
        );
        return;
      }
      setError(null);
      setStep('confirm');
      return;
    }
    if (second !== first) {
      setError('They do not match. Start again.');
      setStep('enter');
      setFirst('');
      setSecond('');
      return;
    }
    setBusy(true);
    try {
      const wantBiometrics = useBiometrics && biometryType !== null;
      await appLock.setSecret(method, first, {
        autoLockSeconds: autoLock,
        biometrics: false,
      });
      if (wantBiometrics) {
        try {
          // The system fingerprint prompt must not count as leaving the Vault.
          useVaultSession.getState().expectLeave();
          await appLock.enableBiometrics();
        } catch (bioError) {
          // The lock itself is set; only the fingerprint shortcut failed.
          setError(
            `Fingerprint unlock not enabled: ${describeError(bioError)}`,
          );
        }
      } else {
        await appLock.disableBiometrics();
      }
      onDone();
    } catch (setError_) {
      setError(describeError(setError_));
    } finally {
      setBusy(false);
    }
  }, [
    step,
    first,
    second,
    min,
    method,
    useBiometrics,
    biometryType,
    autoLock,
    onDone,
  ]);

  return (
    <ScrollView contentContainerStyle={styles.setup}>
      <Icon source="shield-lock-outline" size={48} />
      <Text variant="titleLarge" style={styles.title}>
        {step === 'enter'
          ? `Choose a ${method === 'pin' ? 'PIN' : 'password'}`
          : `Repeat the ${method === 'pin' ? 'PIN' : 'password'}`}
      </Text>
      <Text variant="bodySmall" style={styles.dim}>
        Needed every time the Vault opens. This locks the screen only; your
        encrypted files stay protected by your encryption passphrase.
      </Text>

      {step === 'enter' && (
        <SegmentedButtons
          style={styles.segment}
          value={method}
          onValueChange={value => reset(value as LockMethod)}
          buttons={[
            { value: 'pin', label: 'PIN', icon: 'dialpad' },
            {
              value: 'password',
              label: 'Password',
              icon: 'form-textbox-password',
            },
          ]}
        />
      )}

      {method === 'pin' ? (
        <>
          <Dots count={current.length} max={MIN_PIN_LENGTH} />
          <PinPad value={current} onChange={setCurrent} disabled={busy} />
        </>
      ) : (
        <TextInput
          key={step}
          label={step === 'enter' ? 'Password' : 'Repeat password'}
          value={current}
          onChangeText={setCurrent}
          mode="outlined"
          secureTextEntry
          autoFocus
          style={styles.wide}
          onSubmitEditing={() => {
            void next();
          }}
        />
      )}

      {error && (
        <HelperText type="error" visible>
          {error}
        </HelperText>
      )}

      {step === 'confirm' && (
        <View style={styles.wide}>
          <Text variant="labelLarge" style={styles.section}>
            Lock again
          </Text>
          <RadioButton.Group
            value={String(autoLock)}
            onValueChange={value => setAutoLock(Number(value))}
          >
            {AUTO_LOCK_CHOICES.map(choice => (
              <RadioButton.Item
                key={choice.seconds}
                label={
                  choice.seconds === 0
                    ? 'Immediately when I leave'
                    : `${choice.label} after I leave`
                }
                value={String(choice.seconds)}
              />
            ))}
          </RadioButton.Group>
          {biometryType && (
            <Checkbox.Item
              label="Also unlock with fingerprint / face"
              status={useBiometrics ? 'checked' : 'unchecked'}
              onPress={() => setUseBiometrics(!useBiometrics)}
            />
          )}
        </View>
      )}

      <View style={styles.row}>
        <Button onPress={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          mode="contained"
          loading={busy}
          disabled={busy || current.length < min}
          onPress={() => {
            void next();
          }}
        >
          {step === 'enter' ? 'Next' : 'Set lock'}
        </Button>
      </View>
    </ScrollView>
  );
}

/* ---------------------------------------------------------------- unlock */

function formatWait(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.ceil(seconds / 60)} min`;
}

/**
 * Asks for the PIN/password (or fingerprint). Also verifies the user for
 * sensitive changes, via `title`/`submitLabel`.
 */
export function LockScreen({
  settings,
  onUnlocked,
  onReset,
  title = 'Vault is locked',
  allowBiometrics = true,
  onCancel,
}: {
  settings: LockSettings;
  onUnlocked: () => void;
  /** Called after a forgotten PIN was reset with the encryption passphrase. */
  onReset?: () => void;
  title?: string;
  allowBiometrics?: boolean;
  onCancel?: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [waitMs, setWaitMs] = useState(0);
  const [checking, setChecking] = useState(false);
  const [forgotVisible, setForgotVisible] = useState(false);
  const [forgotValue, setForgotValue] = useState('');
  const [forgotError, setForgotError] = useState<string | null>(null);
  const [canReset, setCanReset] = useState(false);
  const triedBiometrics = useRef(false);

  const biometrics = allowBiometrics && settings.biometrics;

  const refreshWait = useCallback(async () => {
    setWaitMs(await appLock.waitRemaining());
  }, []);

  useEffect(() => {
    void refreshWait();
    void vault.hasPassphrase().then(setCanReset);
  }, [refreshWait]);

  useEffect(() => {
    if (waitMs <= 0) {
      return;
    }
    const timer = setTimeout(() => {
      setWaitMs(current => Math.max(0, current - 1000));
    }, 1000);
    return () => clearTimeout(timer);
  }, [waitMs]);

  const tryBiometrics = useCallback(async () => {
    if (await appLock.unlockWithBiometrics()) {
      onUnlocked();
    }
  }, [onUnlocked]);

  useEffect(() => {
    // Offer the fingerprint straight away, once, like the system lock screen.
    if (biometrics && !triedBiometrics.current) {
      triedBiometrics.current = true;
      void tryBiometrics();
    }
  }, [biometrics, tryBiometrics]);

  const submit = useCallback(
    async (secret: string) => {
      if (checking || waitMs > 0) {
        return;
      }
      setChecking(true);
      try {
        const result = await appLock.verify(secret);
        if (result.ok) {
          setError(null);
          onUnlocked();
          return;
        }
        setValue('');
        setWaitMs(result.waitMs);
        setError(
          result.waitMs > 0
            ? 'Too many wrong attempts.'
            : `Wrong ${settings.method === 'pin' ? 'PIN' : 'password'}. ${result.attemptsLeft} attempt${result.attemptsLeft === 1 ? '' : 's'} before a wait.`,
        );
      } finally {
        setChecking(false);
      }
    },
    [checking, waitMs, onUnlocked, settings.method],
  );

  const onPinChange = (next: string) => {
    setValue(next);
    setError(null);
  };

  const onForgot = useCallback(async () => {
    setForgotError(null);
    if (await vault.verifyPassphrase(forgotValue)) {
      await appLock.remove();
      setForgotVisible(false);
      setForgotValue('');
      onReset?.();
    } else {
      setForgotError('That is not your encryption passphrase.');
    }
  }, [forgotValue, onReset]);

  const locked = waitMs > 0;

  return (
    <ScrollView contentContainerStyle={styles.setup}>
      <Icon source="lock-outline" size={48} />
      <Text variant="titleLarge" style={styles.title}>
        {title}
      </Text>
      {locked ? (
        <Text variant="bodyMedium" style={styles.error}>
          Try again in {formatWait(waitMs)}.
        </Text>
      ) : error ? (
        <Text variant="bodyMedium" style={styles.error}>
          {error}
        </Text>
      ) : (
        <Text variant="bodySmall" style={styles.dim}>
          Enter your {settings.method === 'pin' ? 'PIN' : 'password'}
        </Text>
      )}

      {settings.method === 'pin' ? (
        <>
          <Dots count={value.length} max={MIN_PIN_LENGTH} />
          <PinPad
            value={value}
            onChange={onPinChange}
            disabled={locked || checking}
            onSubmit={() => {
              void submit(value);
            }}
            leftKey={
              biometrics ? (
                <TouchableRipple
                  borderless
                  style={styles.key}
                  onPress={() => {
                    void tryBiometrics();
                  }}
                >
                  <Icon source="fingerprint" size={28} />
                </TouchableRipple>
              ) : undefined
            }
          />
        </>
      ) : (
        <>
          <TextInput
            label="Password"
            value={value}
            onChangeText={onPinChange}
            mode="outlined"
            secureTextEntry
            autoFocus={!biometrics}
            disabled={locked}
            style={styles.wide}
            onSubmitEditing={() => {
              void submit(value);
            }}
          />
          <View style={styles.row}>
            {biometrics && (
              <Button
                icon="fingerprint"
                onPress={() => {
                  void tryBiometrics();
                }}
              >
                Fingerprint
              </Button>
            )}
            <Button
              mode="contained"
              loading={checking}
              disabled={locked || checking || value.length === 0}
              onPress={() => {
                void submit(value);
              }}
            >
              Unlock
            </Button>
          </View>
        </>
      )}

      <View style={styles.row}>
        {onCancel && <Button onPress={onCancel}>Cancel</Button>}
        {onReset && (
          <Button onPress={() => setForgotVisible(true)}>
            Forgot {settings.method === 'pin' ? 'PIN' : 'password'}?
          </Button>
        )}
      </View>

      <Portal>
        <Dialog
          visible={forgotVisible}
          onDismiss={() => setForgotVisible(false)}
        >
          <Dialog.Title>Reset the Vault lock</Dialog.Title>
          <Dialog.Content>
            {canReset ? (
              <>
                <Text variant="bodySmall" style={styles.dialogText}>
                  Enter your encryption passphrase to prove it is you. The lock
                  is removed and you can set a new one.
                </Text>
                <TextInput
                  label="Encryption passphrase"
                  value={forgotValue}
                  onChangeText={setForgotValue}
                  mode="outlined"
                  secureTextEntry
                />
                {forgotError && (
                  <HelperText type="error" visible>
                    {forgotError}
                  </HelperText>
                )}
              </>
            ) : (
              <Text variant="bodySmall">
                No encryption passphrase is set on this phone, so there is
                nothing to prove it is you. To reset, clear this app's storage
                in Android Settings → Apps. That also signs you out; your
                Telegram backup is not affected.
              </Text>
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setForgotVisible(false)}>Close</Button>
            {canReset && (
              <Button
                mode="contained"
                disabled={forgotValue.length === 0}
                onPress={() => {
                  void onForgot();
                }}
              >
                Reset lock
              </Button>
            )}
          </Dialog.Actions>
        </Dialog>
      </Portal>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  setup: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: { marginTop: 12, textAlign: 'center' },
  dim: { opacity: 0.7, marginTop: 8, textAlign: 'center' },
  error: { marginTop: 8, textAlign: 'center', color: '#E5484D' },
  segment: { marginTop: 20, alignSelf: 'stretch' },
  wide: { alignSelf: 'stretch', marginTop: 16 },
  section: { marginTop: 16, marginBottom: 4 },
  row: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 12,
    marginTop: 20,
  },
  dots: {
    flexDirection: 'row',
    gap: 14,
    marginVertical: 24,
    minHeight: 16,
  },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 2 },
  pad: { alignItems: 'center' },
  padRow: { flexDirection: 'row' },
  key: {
    width: 76,
    height: 76,
    margin: 6,
    borderRadius: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  padSubmit: { marginTop: 12, alignSelf: 'stretch' },
  dialogText: { marginBottom: 12 },
});

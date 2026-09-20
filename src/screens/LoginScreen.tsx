import React, { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { Button, Card, HelperText, Text, TextInput } from 'react-native-paper';

import { loginFlow, type LoginStep } from '../services/telegram/client';
import { useAppStore } from '../state/store';
import { describeError } from '../utils/logger';

/**
 * Three-step sign-in. Which step is visible is driven by the login flow itself:
 * the 2FA field only appears once Telegram actually asks for a password.
 */
export default function LoginScreen(): React.JSX.Element {
  const config = useAppStore(state => state.config);
  const refreshAuth = useAppStore(state => state.refreshAuth);

  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [step, setStep] = useState<LoginStep>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      loginFlow.subscribe((nextStep, nextError) => {
        setStep(nextStep);
        setError(nextError);
        if (nextStep === 'done') {
          void refreshAuth();
        }
      }),
    [refreshAuth],
  );

  const credentialsMissing = !config.apiId || !config.apiHash;

  const onSendCode = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      // Resolves only once the whole sign-in completes, so we do not await it
      // here — the step subscription drives the UI instead.
      void loginFlow
        .begin(phone.trim())
        .catch(err => setError(describeError(err)));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  }, [phone]);

  const onSubmitCode = useCallback(() => {
    setError(null);
    try {
      loginFlow.submitCode(code);
    } catch (err) {
      setError(describeError(err));
    }
  }, [code]);

  const onSubmitPassword = useCallback(() => {
    setError(null);
    try {
      loginFlow.submitPassword(password);
    } catch (err) {
      setError(describeError(err));
    }
  }, [password]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text variant="headlineSmall" style={styles.title}>
        Sign in to Telegram
      </Text>
      <Text variant="bodyMedium" style={styles.subtitle}>
        Uses your own account over MTProto, so uploads are not capped at the 50
        MB the Bot API allows.
      </Text>

      {credentialsMissing && (
        <Card mode="outlined" style={styles.warningCard}>
          <Card.Content>
            <Text variant="titleSmall">Add your API credentials first</Text>
            <Text variant="bodySmall" style={styles.warningText}>
              Open Settings and enter the API ID and API hash from
              my.telegram.org.
            </Text>
          </Card.Content>
        </Card>
      )}

      <TextInput
        label="Phone number (with country code)"
        value={phone}
        onChangeText={setPhone}
        mode="outlined"
        keyboardType="phone-pad"
        placeholder="+441234567890"
        autoComplete="tel"
        disabled={
          credentialsMissing ||
          step === 'awaiting-code' ||
          step === 'awaiting-password'
        }
        style={styles.input}
      />

      {(step === 'idle' || step === 'error') && (
        <Button
          mode="contained"
          onPress={onSendCode}
          loading={busy}
          disabled={credentialsMissing || phone.trim().length < 6 || busy}
          style={styles.button}
        >
          Send code
        </Button>
      )}

      {step === 'sending-code' && (
        <Button mode="contained" loading disabled style={styles.button}>
          Sending code…
        </Button>
      )}

      {(step === 'awaiting-code' || step === 'signing-in') && (
        <>
          <TextInput
            label="Login code"
            value={code}
            onChangeText={setCode}
            mode="outlined"
            keyboardType="number-pad"
            style={styles.input}
          />
          <HelperText type="info" visible>
            Telegram sends this inside the Telegram app, not by SMS.
          </HelperText>
          <Button
            mode="contained"
            onPress={onSubmitCode}
            loading={step === 'signing-in'}
            disabled={code.trim().length < 4 || step === 'signing-in'}
            style={styles.button}
          >
            Verify
          </Button>
        </>
      )}

      {step === 'awaiting-password' && (
        <>
          <TextInput
            label="Two-step verification password"
            value={password}
            onChangeText={setPassword}
            mode="outlined"
            secureTextEntry
            style={styles.input}
          />
          {loginFlow.passwordHint && (
            <HelperText type="info" visible>
              Hint: {loginFlow.passwordHint}
            </HelperText>
          )}
          <Button
            mode="contained"
            onPress={onSubmitPassword}
            disabled={password.length === 0}
            style={styles.button}
          >
            Sign in
          </Button>
        </>
      )}

      {step === 'done' && (
        <Text variant="bodyMedium" style={styles.success}>
          Signed in. Your session is stored in the Android Keystore.
        </Text>
      )}

      {error && (
        <HelperText type="error" visible style={styles.error}>
          {error}
        </HelperText>
      )}

      {step !== 'idle' && step !== 'done' && (
        <Button
          mode="text"
          onPress={() => {
            loginFlow.cancel();
            setCode('');
            setPassword('');
          }}
          style={styles.button}
        >
          Start over
        </Button>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 48 },
  title: { marginBottom: 8 },
  subtitle: { marginBottom: 20, opacity: 0.7 },
  warningCard: { marginBottom: 20 },
  warningText: { marginTop: 4, opacity: 0.8 },
  input: { marginBottom: 8 },
  button: { marginTop: 12 },
  success: { marginTop: 16 },
  error: { marginTop: 8 },
});

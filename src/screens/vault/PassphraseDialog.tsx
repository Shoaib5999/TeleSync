import React, { useState } from 'react';
import { StyleSheet } from 'react-native';
import { Button, Dialog, Portal, Text, TextInput } from 'react-native-paper';

/**
 * Asks for the encryption passphrase of a backup made on another phone or an
 * earlier install. Once a file opens with it, the key is remembered, so this
 * appears once per backup rather than once per file.
 */
export default function PassphraseDialog({
  visible,
  wrong,
  onSubmit,
  onDismiss,
}: {
  visible: boolean;
  /** The last attempt did not open the file. */
  wrong: boolean;
  onSubmit: (passphrase: string) => void;
  onDismiss: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState('');
  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>Backup passphrase</Dialog.Title>
        <Dialog.Content>
          <Text variant="bodySmall" style={styles.text}>
            {wrong
              ? 'That passphrase does not open this file. If you ever changed it, try the older one.'
              : 'This file was encrypted on another device or an earlier install. Enter the passphrase you used then. It is checked against the file and remembered once it works.'}
          </Text>
          <TextInput
            label="Encryption passphrase"
            value={value}
            onChangeText={setValue}
            mode="outlined"
            secureTextEntry
            autoFocus
          />
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button
            mode="contained"
            disabled={value.length === 0}
            onPress={() => {
              const entered = value;
              setValue('');
              onSubmit(entered);
            }}
          >
            Unlock
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  text: { marginBottom: 12 },
});

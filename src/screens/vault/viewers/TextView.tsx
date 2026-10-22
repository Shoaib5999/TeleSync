import React, { useEffect, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { ActivityIndicator, Text } from 'react-native-paper';
import ReactNativeBlobUtil from 'react-native-blob-util';

import { describeError } from '../../../utils/logger';

/** Beyond this only the start is shown; a phone is not a log analyser. */
const MAX_BYTES = 2 * 1024 * 1024;
const LINES_PER_BLOCK = 150;

async function readText(
  path: string,
): Promise<{ text: string; truncated: boolean }> {
  const stat = await ReactNativeBlobUtil.fs.stat(path);
  const size = Number(stat.size);
  if (size <= MAX_BYTES) {
    return {
      text: (await ReactNativeBlobUtil.fs.readFile(path, 'utf8')) as string,
      truncated: false,
    };
  }
  const head = `${path}.head`;
  await ReactNativeBlobUtil.fs.slice(path, head, 0, MAX_BYTES);
  try {
    return {
      text: (await ReactNativeBlobUtil.fs.readFile(head, 'utf8')) as string,
      truncated: true,
    };
  } finally {
    await ReactNativeBlobUtil.fs.unlink(head).catch(() => undefined);
  }
}

/**
 * Plain text, code, JSON, CSV, logs. Rendered in blocks of lines so a large
 * file scrolls instead of stalling on one enormous Text node.
 */
export default function TextView({
  path,
  name,
  inlineText,
}: {
  /** File to read; omit when `inlineText` is given. */
  path?: string;
  name: string;
  /** Text already in hand, e.g. a text-only message. */
  inlineText?: string;
}): React.JSX.Element {
  const [blocks, setBlocks] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      let text = inlineText ?? '';
      if (path) {
        const result = await readText(path);
        text = result.text;
        if (alive) {
          setTruncated(result.truncated);
        }
      }
      if (name.toLowerCase().endsWith('.json') && text.length < 1024 * 1024) {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          // Not valid JSON; show it as is.
        }
      }
      const lines = text.split('\n');
      const chunks: string[] = [];
      for (let i = 0; i < lines.length; i += LINES_PER_BLOCK) {
        chunks.push(lines.slice(i, i + LINES_PER_BLOCK).join('\n'));
      }
      if (alive) {
        setBlocks(chunks);
      }
    };
    load().catch(err => alive && setError(describeError(err)));
    return () => {
      alive = false;
    };
  }, [path, name, inlineText]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.text}>Could not read this file: {error}</Text>
      </View>
    );
  }
  if (!blocks) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  return (
    <FlatList
      data={blocks}
      keyExtractor={(_, i) => String(i)}
      contentContainerStyle={styles.list}
      initialNumToRender={3}
      renderItem={({ item }) => (
        <Text selectable style={[styles.text, !inlineText && styles.mono]}>
          {item}
        </Text>
      )}
      ListFooterComponent={
        truncated ? (
          <Text style={styles.note}>
            Showing the first 2 MB. Save or open with another app for the rest.
          </Text>
        ) : undefined
      }
    />
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  list: { padding: 16 },
  text: { color: '#eee', fontSize: 14, lineHeight: 20 },
  mono: { fontFamily: 'monospace', fontSize: 12, lineHeight: 17 },
  note: { color: '#aaa', marginTop: 16, fontStyle: 'italic' },
});

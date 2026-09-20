import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Button, Divider, SegmentedButtons, Text } from 'react-native-paper';

import { logger } from '../utils/logger';
import type { LogEntry, LogLevel } from '../types';

type Filter = 'all' | LogLevel;

const LEVEL_COLOUR: Record<LogLevel, string> = {
  info: '#5F6368',
  warn: '#E37400',
  error: '#B3261E',
};

function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export default function LogsScreen(): React.JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>(() => logger.all());
  const [filter, setFilter] = useState<Filter>('all');

  // Live-updates while a sync runs, so the screen is useful for debugging.
  useEffect(() => logger.subscribe(setEntries), []);

  const visible = useMemo(
    () =>
      filter === 'all'
        ? entries
        : entries.filter(entry => entry.level === filter),
    [entries, filter],
  );

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <SegmentedButtons
          value={filter}
          onValueChange={value => setFilter(value as Filter)}
          buttons={[
            { value: 'all', label: 'All' },
            { value: 'info', label: 'Info' },
            { value: 'warn', label: 'Warn' },
            { value: 'error', label: 'Error' },
          ]}
        />
        <Button
          onPress={() => {
            logger.clear();
            setEntries([]);
          }}
          style={styles.clear}
        >
          Clear log
        </Button>
      </View>

      <FlatList
        data={visible}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={Divider}
        ListEmptyComponent={
          <Text variant="bodyMedium" style={styles.empty}>
            Nothing logged yet.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.rowHeader}>
              <Text
                variant="labelSmall"
                style={{ color: LEVEL_COLOUR[item.level] }}
              >
                {item.level.toUpperCase()} · {item.scope}
              </Text>
              <Text variant="labelSmall" style={styles.time}>
                {formatTime(item.ts)}
              </Text>
            </View>
            <Text variant="bodySmall">{item.message}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { padding: 16, paddingBottom: 8 },
  clear: { marginTop: 8, alignSelf: 'flex-start' },
  list: { paddingHorizontal: 16, paddingBottom: 32 },
  row: { paddingVertical: 10 },
  rowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  time: { opacity: 0.5 },
  empty: { textAlign: 'center', marginTop: 32, opacity: 0.6 },
});

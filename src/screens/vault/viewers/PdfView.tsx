import React, { useEffect, useState } from 'react';
import {
  FlatList,
  Image,
  PixelRatio,
  StyleSheet,
  TouchableWithoutFeedback,
  View,
  useWindowDimensions,
} from 'react-native';
import { ActivityIndicator, IconButton, Text } from 'react-native-paper';

import { pdfPageCount, renderPdfPage } from '../../../services/vault/native';
import { vaultCacheDir } from '../../../services/telegram/browse';
import { describeError } from '../../../utils/logger';
import ZoomableImage from './ZoomableImage';

/** One page, rendered by the platform PdfRenderer the first time it scrolls in. */
function Page({
  path,
  cacheKey,
  index,
  width,
  onOpen,
}: {
  path: string;
  cacheKey: string;
  index: number;
  width: number;
  onOpen: (uri: string) => void;
}) {
  const [page, setPage] = useState<{ uri: string; ratio: number } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    // Render at device pixels (capped) so text stays sharp when zoomed a bit.
    const px = Math.min(1800, Math.round(width * PixelRatio.get()));
    renderPdfPage(
      path,
      index,
      px,
      `${vaultCacheDir()}/pdf/${cacheKey}-${index}-${px}.png`,
    )
      .then(result => {
        if (alive) {
          setPage({
            uri: `file://${result.path}`,
            ratio: result.height / Math.max(1, result.width),
          });
        }
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [path, cacheKey, index, width]);

  const height = width * (page?.ratio ?? 1.414);
  return (
    <View style={[styles.page, { width, height }]}>
      {page ? (
        <TouchableWithoutFeedback onPress={() => onOpen(page.uri)}>
          <Image source={{ uri: page.uri }} style={{ width, height }} />
        </TouchableWithoutFeedback>
      ) : failed ? (
        <Text variant="bodySmall">Page {index + 1} could not be rendered.</Text>
      ) : (
        <ActivityIndicator />
      )}
    </View>
  );
}

/** Scrollable PDF; tap a page to zoom into it. */
export default function PdfView({
  path,
  cacheKey,
}: {
  path: string;
  cacheKey: string;
}): React.JSX.Element {
  const { width } = useWindowDimensions();
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);

  useEffect(() => {
    pdfPageCount(path)
      .then(setCount)
      .catch(err => setError(describeError(err)));
  }, [path]);

  if (error) {
    return (
      <View style={styles.center}>
        <Text variant="bodyMedium" style={styles.light}>
          This PDF could not be opened: {error}
        </Text>
      </View>
    );
  }
  if (count === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }
  if (zoomed) {
    return (
      <View style={styles.fill}>
        <ZoomableImage uri={zoomed} />
        <IconButton
          icon="arrow-collapse"
          mode="contained"
          style={styles.unzoom}
          onPress={() => setZoomed(null)}
        />
      </View>
    );
  }

  const pageWidth = width - 16;
  return (
    <FlatList
      data={Array.from({ length: count }, (_, i) => i)}
      keyExtractor={i => String(i)}
      contentContainerStyle={styles.list}
      initialNumToRender={2}
      windowSize={5}
      ListHeaderComponent={
        <Text variant="labelSmall" style={styles.count}>
          {count} page{count === 1 ? '' : 's'} · tap a page to zoom
        </Text>
      }
      renderItem={({ item }) => (
        <Page
          path={path}
          cacheKey={cacheKey}
          index={item}
          width={pageWidth}
          onOpen={setZoomed}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  light: { color: '#fff', textAlign: 'center' },
  list: { padding: 8, alignItems: 'center' },
  page: {
    marginBottom: 8,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  count: { color: '#bbb', marginBottom: 8 },
  unzoom: { position: 'absolute', top: 8, right: 8 },
});

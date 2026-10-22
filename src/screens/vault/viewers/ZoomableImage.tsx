import React, { useMemo, useRef } from 'react';
import {
  Animated,
  Image,
  PanResponder,
  StyleSheet,
  type GestureResponderEvent,
} from 'react-native';

const MAX_SCALE = 5;
const DOUBLE_TAP_MS = 280;
const SWIPE_PX = 70;

function distance(event: GestureResponderEvent): number {
  const [a, b] = event.nativeEvent.touches;
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

/**
 * An image with pinch-zoom, pan and double-tap, built on PanResponder.
 *
 * Android's ScrollView has no zoom (maximumZoomScale is iOS-only), and adding a
 * gesture library means a new native dependency; this is small enough not to.
 * At 1x a horizontal fling calls onSwipe, so the viewer can page through items.
 */
export default function ZoomableImage({
  uri,
  onSwipe,
  onError,
}: {
  uri: string;
  onSwipe?: (direction: 'next' | 'prev') => void;
  onError?: () => void;
}): React.JSX.Element {
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  // Plain numbers mirror the animated values, since reading those is async.
  const state = useRef({
    scale: 1,
    x: 0,
    y: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
    startDistance: 0,
    pinching: false,
    lastTap: 0,
  }).current;

  const responder = useMemo(() => {
    const apply = (nextScale: number, x: number, y: number) => {
      state.scale = nextScale;
      state.x = x;
      state.y = y;
      scale.setValue(nextScale);
      translateX.setValue(x);
      translateY.setValue(y);
    };
    const reset = () => {
      state.scale = 1;
      state.x = 0;
      state.y = 0;
      Animated.parallel([
        Animated.spring(scale, { toValue: 1, useNativeDriver: true }),
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
        Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
      ]).start();
    };

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: event => {
        state.startScale = state.scale;
        state.startX = state.x;
        state.startY = state.y;
        state.pinching = event.nativeEvent.touches.length === 2;
        if (state.pinching) {
          state.startDistance = distance(event);
        }
      },
      onPanResponderMove: (event, gesture) => {
        const touches = event.nativeEvent.touches.length;
        if (touches === 2) {
          if (!state.pinching) {
            // Second finger arrived mid-gesture: start the pinch from here.
            state.pinching = true;
            state.startDistance = distance(event);
            state.startScale = state.scale;
            return;
          }
          const ratio = distance(event) / Math.max(1, state.startDistance);
          const next = Math.min(
            MAX_SCALE,
            Math.max(1, state.startScale * ratio),
          );
          apply(next, state.x, state.y);
        } else if (touches === 1 && !state.pinching && state.scale > 1) {
          apply(
            state.scale,
            state.startX + gesture.dx,
            state.startY + gesture.dy,
          );
        }
      },
      onPanResponderRelease: (_event, gesture) => {
        const wasPinching = state.pinching;
        state.pinching = false;
        const tap = Math.abs(gesture.dx) < 8 && Math.abs(gesture.dy) < 8;

        if (tap && !wasPinching) {
          const now = Date.now();
          if (now - state.lastTap < DOUBLE_TAP_MS) {
            state.lastTap = 0;
            if (state.scale > 1) {
              reset();
            } else {
              apply(2.5, 0, 0);
            }
          } else {
            state.lastTap = now;
          }
          return;
        }

        if (state.scale <= 1.01) {
          if (
            !wasPinching &&
            onSwipe &&
            Math.abs(gesture.dx) > SWIPE_PX &&
            Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5
          ) {
            onSwipe(gesture.dx < 0 ? 'next' : 'prev');
          }
          reset();
        }
      },
      onPanResponderTerminationRequest: () => false,
    });
  }, [onSwipe, scale, translateX, translateY, state]);

  return (
    <Animated.View style={styles.fill} {...responder.panHandlers}>
      <Animated.View
        style={[
          styles.fill,
          {
            transform: [{ translateX }, { translateY }, { scale }],
          },
        ]}
      >
        <Image
          source={{ uri }}
          style={styles.fill}
          resizeMode="contain"
          onError={onError}
        />
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, width: '100%' },
});

import './polyfills';

import React, { useEffect } from 'react';
import { StatusBar, StyleSheet, useColorScheme, View } from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  DarkTheme,
} from '@react-navigation/native';
import { ActivityIndicator, PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import MaterialDesignIcons from '@react-native-vector-icons/material-design-icons';

import RootNavigator from './navigation';
import { useAppStore } from './state/store';
import { darkTheme, lightTheme } from './theme';
import { scheduleSync } from './background/scheduler';
import { logger, describeError } from './utils/logger';

export default function App(): React.JSX.Element {
  const scheme = useColorScheme();
  const isDark = scheme === 'dark';

  const ready = useAppStore(state => state.ready);
  const auth = useAppStore(state => state.auth);
  const initialise = useAppStore(state => state.initialise);

  useEffect(() => {
    void initialise();
  }, [initialise]);

  useEffect(() => {
    // Register the periodic job once we know the account is usable. Doing it
    // before login would schedule work that can only fail.
    if (ready && auth.loggedIn) {
      void scheduleSync().catch(error =>
        logger.warn(
          'app',
          `Could not schedule periodic sync: ${describeError(error)}`,
        ),
      );
    }
  }, [ready, auth.loggedIn]);

  const paperTheme = isDark ? darkTheme : lightTheme;
  const navTheme = isDark ? DarkTheme : DefaultTheme;

  return (
    <SafeAreaProvider>
      <PaperProvider
        theme={paperTheme}
        settings={{
          icon: props => <MaterialDesignIcons {...props} />,
        }}
      >
        {/* RN 0.87 is edge-to-edge by default; backgroundColor is gone. */}
        <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
        <NavigationContainer theme={navTheme}>
          {ready ? (
            <RootNavigator loggedIn={auth.loggedIn} />
          ) : (
            <View style={styles.loading}>
              <ActivityIndicator size="large" />
            </View>
          )}
        </NavigationContainer>
      </PaperProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

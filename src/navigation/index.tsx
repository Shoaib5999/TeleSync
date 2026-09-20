import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import MaterialDesignIcons from '@react-native-vector-icons/material-design-icons';

import HomeScreen from '../screens/HomeScreen';
import FoldersScreen from '../screens/FoldersScreen';
import TopicsScreen from '../screens/TopicsScreen';
import LogsScreen from '../screens/LogsScreen';
import SettingsScreen from '../screens/SettingsScreen';
import LoginScreen from '../screens/LoginScreen';
import LibraryScreen from '../screens/LibraryScreen';
import DeletionsScreen from '../screens/DeletionsScreen';

export type RootTabParamList = {
  Home: undefined;
  Library: undefined;
  Folders: undefined;
  Topics: undefined;
  Deletions: undefined;
  Logs: undefined;
  Settings: undefined;
  Login: undefined;
};

const Tab = createBottomTabNavigator<RootTabParamList>();

type IconName = React.ComponentProps<typeof MaterialDesignIcons>['name'];

const ICONS: Record<keyof RootTabParamList, IconName> = {
  Home: 'cloud-upload',
  Library: 'image-multiple',
  Folders: 'folder-multiple',
  Topics: 'forum',
  Deletions: 'delete-alert-outline',
  Logs: 'text-box-outline',
  Settings: 'cog',
  Login: 'login',
};

/**
 * Signed out, only Login and Settings are reachable — and Settings has to be,
 * because signing in needs the API ID and hash entered there first.
 */
export default function RootNavigator({
  loggedIn,
}: {
  loggedIn: boolean;
}): React.JSX.Element {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: true,
        tabBarIcon: ({ color, size }) => (
          <MaterialDesignIcons
            name={ICONS[route.name]}
            color={color}
            size={size}
          />
        ),
      })}
    >
      {loggedIn ? (
        <>
          <Tab.Screen
            name="Home"
            component={HomeScreen}
            options={{ title: 'Backup' }}
          />
          <Tab.Screen
            name="Library"
            component={LibraryScreen}
            options={{ title: 'Restore' }}
          />
          <Tab.Screen name="Folders" component={FoldersScreen} />
          <Tab.Screen name="Topics" component={TopicsScreen} />
          <Tab.Screen
            name="Deletions"
            component={DeletionsScreen}
            options={{ title: 'Review' }}
          />
          <Tab.Screen name="Logs" component={LogsScreen} />
          <Tab.Screen name="Settings" component={SettingsScreen} />
        </>
      ) : (
        <>
          <Tab.Screen
            name="Login"
            component={LoginScreen}
            options={{ title: 'Sign in' }}
          />
          <Tab.Screen name="Settings" component={SettingsScreen} />
          <Tab.Screen name="Logs" component={LogsScreen} />
        </>
      )}
    </Tab.Navigator>
  );
}

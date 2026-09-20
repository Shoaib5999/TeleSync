/**
 * Entry point.
 *
 * Polyfills must load before anything can import teleproto, so they come first
 * and before the App import.
 */
import './src/polyfills';

import { AppRegistry } from 'react-native';

import App from './src/App';
import { headlessSyncTask } from './src/background/scheduler';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);

// Matches SyncHeadlessTaskService.TASK_KEY. WorkManager starts that service,
// which runs this task; it calls the same engine the UI does.
AppRegistry.registerHeadlessTask('TelegramBackupSync', () => headlessSyncTask);

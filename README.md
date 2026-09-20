# Telegram Backup

One-way backup of your Android phone's photos, videos and documents into a
private Telegram channel, sorted into Telegram Topics. Uploads run in a
foreground service, survive the screen going off, and resume where they left
off.

Deleting a file on your phone **never** deletes it from Telegram.

---

## Two deviations from the original spec

Both were forced by what is actually current and working; everything else is
built as specified.

### 1. `gramjs` is archived — this uses `teleproto`

Installing `telegram` (gramjs) prints:

```
npm warn deprecated telegram@2.26.22: This package is archived and no longer
maintained. Development continues in teleproto, a largely compatible, actively
maintained fork.
```

`teleproto@1.229.0` (last published August 2026) is that fork and is what this
project uses. It is the same MTProto library with the same `TelegramClient`,
`Api.*` and `StringSession` API, so everything the spec asked for still holds:
2 GB uploads on a free account, 4 GB with Premium, a persistable session
string, and no 50 MB Bot API cap.

It is also a better fit for React Native than gramjs was: it dropped the
`websocket`, `pako`, `buffer` and `@cryptography/aes` dependencies, so far less
Node-specific code ends up in the bundle.

### 2. `react-native-sqlite-storage` → `@op-engineering/op-sqlite`

`react-native-sqlite-storage@6.0.1` was last touched in February 2025 and is an
old-architecture bridge module. React Native 0.87 enables the New Architecture
by default, where it would run through the interop layer at best.

`@op-engineering/op-sqlite@18.2.3` (published days ago) is a JSI/C++ TurboModule
with first-class New Architecture support, and is materially faster for the
per-file index lookups the scanner does on every file it sees.

Two smaller substitutions for the same reason — the package named in the spec is
deprecated and has a direct successor:

| Spec said | Used instead | Why |
|---|---|---|
| `react-native-document-picker` | `@react-native-documents/picker@12.0.2` | Same author; the old name is deprecated |
| `react-native-fs` | `react-native-blob-util@0.25.0` | `react-native-fs` is stale; blob-util has the `fs.slice` range-read the chunked uploader needs |
| `react-native-foreground-service` | custom Kotlin service | The npm package of that name is an abandoned `1.0.0` stub. The service here is ~80 lines and gives exact control over the Android 14 `dataSync` type and the Pause/Stop actions |

---

## How gramjs/teleproto is made to run on React Native

This is the part that usually defeats people, so it is worth stating plainly.
teleproto is published as Node CommonJS and assumes Node built-ins. React Native
has none of them. Three things bridge the gap.

**1. No raw TCP.** React Native has no `net` module, so `PromisedNetSockets`
can never work. `services/telegram/client.ts` passes
`networkSocket: PromisedWebSockets`, which makes teleproto talk MTProto over
Telegram's WSS endpoints and switch the transport to `ConnectionTCPObfuscated`
automatically. This is the same path Telegram Web uses.

**2. Real, synchronous crypto.** teleproto calls `createCipheriv("aes-256-cbc")`,
`createHash`, `pbkdf2Sync` and `randomBytes` **synchronously**. WebCrypto cannot
back these — `crypto.subtle` is async-only. `shims/crypto.js` maps them to
`react-native-quick-crypto`, which implements the Node API natively over
JSI/OpenSSL. This is not an optimisation: MTProto encrypts every packet, a 2 GB
upload is ~4000 chunks, and the 2FA login runs PBKDF2 at 100,000 iterations.
Pure JS would freeze the UI thread.

**3. Everything else is shimmed or stubbed.** `metro.config.js` redirects each
Node built-in to a file in `shims/`, with a comment explaining what teleproto
actually calls on it. `fs`, `net`, `socks` and `node-localstorage` are stubs
that throw if used, because the code paths that touch them (Node file uploads,
TCP sockets, `StoreSession`) are ones this app never takes.

One subtlety worth knowing if you edit `metro.config.js`:
`require.resolve('events')` returns Node's *builtin* id, not a file path, and
Metro then fails with `Failed to get the SHA-1 for: events`. The `pkg()` helper
adds a trailing slash to force node_modules resolution.

Uploads do **not** use `client.uploadFile` — that helper requires Node `fs`.
`services/telegram/upload.ts` implements its own chunked uploader that reads
512 KB ranges with `ReactNativeBlobUtil.fs.slice` and calls
`Api.upload.SaveBigFilePart` directly, which keeps memory flat regardless of
file size.

---

## Key features

- **Own-account MTProto** — 2 GB files free, 4 GB with Premium. No 50 MB Bot API cap.
- **Folder → topic routing**, longest-prefix match, edited in-app.
- **Selective sync** — tick exactly which folders a run covers, or sync one folder from its row.
- **Incremental and resumable** — a file is re-uploaded only if its size or mtime changed.
- **Foreground service + wake lock** — uploads keep full speed with the screen off.
- **Scheduled sync** via WorkManager, with Wi-Fi-only and charging constraints.
- **FLOOD_WAIT and slow-mode handled by obeying them**, not by retrying blindly.
- **Optional per-folder AES-256-GCM encryption** — the key is derived on-device and never uploaded.
- **Optional deletion mirroring**, per folder, gated behind an explicit review screen.
- **Restore tab** — browse the backup, preview photos, play videos, save back to the device.
- **One-way by default** — deleting a file on the phone never touches the backup unless you opt in.

---

## Encryption

Off by default. Enable it **per folder** from the Folders tab, after setting a
passphrase in Settings.

- AES-256-GCM, unique IV per file, key derived with PBKDF2-SHA256 (200k iterations).
- The key lives in the Android Keystore and is never uploaded. Telegram stores
  ciphertext only.
- Encryption is **per file, not per folder-as-a-blob**. Encrypting a folder as a
  single archive would mean re-uploading everything whenever one photo changed,
  with no resumability and no way to restore a single item.
- Enter the same passphrase on another device to read the backup there.

**There is no recovery.** Forget the passphrase and every encrypted file is
permanently unreadable — that is the point, and it applies to you as much as to
anyone else.

**Trade-off worth knowing:** encrypted files have no Telegram-side thumbnails,
because the server sees an opaque blob. Encrypted photos still preview fast
(a 150 KB file *is* its own thumbnail), but an encrypted **video must download in
full** before it can play, since GCM cannot be partially decrypted. Unencrypted
videos preview instantly. Encrypt documents freely; think twice about large
video folders.

---

## Deletion mirroring

Off by default, enabled **per folder**. Even then, nothing is ever deleted
automatically.

When a sync notices a file has gone from a mirrored folder, it writes a
**proposal** and posts a notification. The Review tab lists them, and the
Telegram copy is removed only when you approve it. "Keep" dismisses a proposal
for good, so a file you meant to keep does not reappear after every scan.

Three guards exist because being wrong here destroys the last copy of a file:

1. A folder that is **missing or unreadable** is skipped entirely — an unmounted
   SD card or a revoked storage permission makes every file look deleted.
2. A folder where **every** known file appears missing is skipped, since that is
   far more likely a mount problem than a genuine mass delete.
3. Nothing is proposed twice, and approval is always an explicit tap.

---

## Restore

The **Restore** tab lists what has been backed up.

- Tapping an item downloads it into the app's private cache and decrypts it if
  needed. Photos display, videos play in-app.
- **Previewing never writes to your storage.** Files reach the device only via
  **Save to device**, which restores to the original folder path and never
  overwrites an existing file (it suffixes instead).
- **Clear preview cache** wipes the decrypted copies, in Settings or on the tab.

---

## Prerequisites

- **Android Studio** with an SDK for API 37 and build-tools 37.0.0
- **JDK 17** — React Native 0.87 targets 17. Newer JDKs may fail the Gradle
  build; if you have several installed, point `JAVA_HOME` at 17 explicitly
- **Node 20+** and npm 10+
- A **real Android device**. The emulator has no photo library worth backing up
  and cannot exercise the foreground-service behaviour properly

---

## First run: exact commands

```bash
# 1. Create the project (skip if you were handed the folder already)
npx @react-native-community/cli@20.2.0 init TelegramBackup --version 0.87.1
cd TelegramBackup

# 2. Paste in the files from this repo, then install
npm install

# 3. Point Gradle at JDK 17
export JAVA_HOME=$(/usr/libexec/java_home -v 17)   # macOS
# export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64   # Linux

# 4. Plug in your phone with USB debugging on, then confirm it is visible
adb devices

# 5. Build and install the debug APK
cd android && ./gradlew installDebug && cd ..

# 6. Start Metro in a second terminal
npm start
```

The app launches on the phone. It will show the login screen, but sign-in will
not work until you add API credentials — that is the next section.

To build the APK without installing:

```bash
cd android && ./gradlew assembleDebug
```

The APK lands at `android/app/build/outputs/apk/debug/app-debug.apk`.

Expect it to be around 200 MB. That is normal for a debug build: it packs three
ABIs (arm64-v8a, armeabi-v7a, x86) with unstripped native symbols, and this app
carries real native code — Hermes, quick-crypto's OpenSSL, op-sqlite, MMKV and
Nitro. A debug APK also does **not** embed the JS bundle; it loads from Metro,
so `npm start` has to be running.

A release build is far smaller. Add ABI splits to `android/app/build.gradle`:

```gradle
android {
    splits {
        abi {
            enable true
            reset()
            include "arm64-v8a", "armeabi-v7a"
            universalApk false
        }
    }
}
```

The arm64 release APK — the only one modern phones need — comes out in the tens
of megabytes, with the JS bundle embedded so Metro is not required.

---

## Setup inside the app

### 1. Get an API ID and API hash

1. Go to <https://my.telegram.org> and log in with your phone number.
2. Open **API development tools**.
3. Create an application — any title and short name will do.
4. Copy the **App api_id** and **App api_hash**.

Enter both in the app's **Settings** tab. The hash is written to the Android
Keystore, never to plain storage.

### 2. Create the channel and enable Topics

1. In Telegram: **New Channel**, make it **Private**.
2. Open the channel → **Edit** → **Topics** → turn it on.

Topics are what the app uses as folders. Without them everything lands in one
undifferentiated stream.

### 3. Find the channel ID

Either:

- Forward any message from the channel to [@userinfobot](https://t.me/userinfobot),
  which replies with the id; or
- Open the channel in Telegram Web and take the id from the URL.

It looks like `-1001234567890` — keep the leading `-100`. Paste it into
**Settings → Channel ID**.

### 4. Sign in

Go to the login screen and enter your phone number with country code. The code
arrives **inside the Telegram app**, not by SMS. If you have two-step
verification on, a password field appears after the code.

### 5. Create topics and bind folders

- **Topics** tab → **Refresh** to list what is on the channel, **New topic** to
  add one. Something like `Personal Photos`, `General Photos`, `Documents`,
  `Movies`.
- **Folders** tab → **Add folder** to pick a local folder and bind it to a topic.

Typical bindings:

| Folder | Topic |
|---|---|
| `/storage/emulated/0/DCIM/Camera` | Personal Photos |
| `/storage/emulated/0/Pictures` | General Photos |
| `/storage/emulated/0/Documents` | Documents |
| `/storage/emulated/0/Movies` | Movies |

Matching is **longest prefix wins**, so a binding on `/DCIM/Camera` beats one on
`/DCIM` for files inside Camera. Anything that matches nothing goes to the root
topic set in Settings, or the channel itself if none is set.

### 6. Grant All files access

Photos and videos work with the normal media permissions. `Documents`, `Movies`
and any custom folder do **not** — MediaStore does not index them, so they scan
as empty without all-files access. The Home screen shows a prompt with a button
that opens the right settings page.

This is why the app is sideload-only: `MANAGE_EXTERNAL_STORAGE` needs a declared
use exemption for Play Store distribution.

---

## How the background work fits together

There are two entry points and **one** sync implementation
(`src/services/sync/engine.ts`). Neither duplicates the other.

**User-initiated ("Start Sync").** JS starts `SyncForegroundService`, a
`dataSync` foreground service whose only job is keeping the process alive so the
JS upload loop keeps running with the screen off. Progress is mirrored into the
notification; Pause/Stop broadcast back to the engine.

**Scheduled (every N hours).** A WorkManager `PeriodicWorkRequest` runs
`SyncWorker`. The worker calls `setForeground()` *first* — on Android 12+ an app
in the background may not start a foreground service itself, and WorkManager
holds the exemption — and then starts `SyncHeadlessTaskService`, which runs the
JS task registered in `index.js`. The worker waits on `SyncCoordinator` until JS
reports done, so its notification is not torn down mid-upload.

### Android will still sometimes kill it

A foreground service is a strong hint, not a guarantee. Aggressive OEM battery
managers — Xiaomi, Huawei, Samsung, OnePlus, Oppo are the usual suspects — kill
background work regardless.

If syncs stop partway:

1. **Settings → Battery settings** in the app, and set this app to
   **Unrestricted** / **Don't optimise**.
2. On Xiaomi/Oppo/Vivo, also enable **Autostart** for the app.
3. Lock the app in the recents screen if your launcher supports it.

Nothing is lost when it does get killed: every completed upload is already in
SQLite, so the next run resumes rather than restarting.

---

## Deletion behaviour

This is a one-way backup, and the code is written to make that hard to break.

- A file in the index that is **missing from the phone** is left completely
  alone. No message is deleted, no topic is touched. There is deliberately no
  code path that walks the table looking for orphans.
- The **only** remote deletion the engine performs is replacing a message whose
  file changed in place (different size or mtime). The new copy is uploaded
  first, and only then is the old message deleted, so a crash mid-way never
  loses both.
- `TopicsScreen` can delete a whole topic, but only from an explicit confirmed
  tap. The sync engine never calls it.
- **Clear local DB** in Settings wipes the index only. Telegram is untouched —
  but the next sync will re-upload everything and create duplicates.

---

## Release build

Generate a signing key:

```bash
keytool -genkeypair -v -storetype PKCS12 \
  -keystore telegram-backup.keystore \
  -alias telegram-backup -keyalg RSA -keysize 2048 -validity 10000
```

Put it in `android/app/`, then create `android/keystore.properties`:

```properties
storeFile=telegram-backup.keystore
keyAlias=telegram-backup
storePassword=*****
keyPassword=*****
```

Use a **separate** file rather than `android/gradle.properties`. The scaffold
git-ignores `*.keystore` but **not** `gradle.properties`, which also holds
ordinary build config (`newArchEnabled`, `hermesEnabled`) that belongs in
version control — so putting passwords there is how they end up committed.
`android/keystore.properties` is git-ignored by this project's `.gitignore`.

In `android/app/build.gradle`, load it and point `release` at it:

```gradle
def keystorePropertiesFile = rootProject.file("keystore.properties")
def keystoreProperties = new Properties()
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

android {
    signingConfigs {
        release {
            if (keystorePropertiesFile.exists()) {
                storeFile file(keystoreProperties['storeFile'])
                storePassword keystoreProperties['storePassword']
                keyAlias keystoreProperties['keyAlias']
                keyPassword keystoreProperties['keyPassword']
            }
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled enableProguardInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"
        }
    }
}
```

Then:

```bash
cd android && ./gradlew assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`.

---

## Testing on a real device

```bash
adb devices                                   # confirm the phone is listed
cd android && ./gradlew installDebug
adb logcat -s ReactNativeJS:V                 # watch the JS log
```

A sensible first run:

1. Sign in, add the channel id, refresh topics.
2. Bind **one small folder** — not the whole camera roll — and sync it.
3. Check the files landed in the right topic in Telegram.
4. Lock the phone mid-sync and confirm the notification keeps counting up.
5. Modify a file you already backed up and re-sync; confirm exactly one copy
   exists afterwards.
6. Delete a file from the phone and re-sync; confirm it is **still** in Telegram.

The **Logs** tab shows the last 1000 entries and updates live, which is usually
faster than logcat for diagnosing a stuck sync.

---

## Troubleshooting

**`FLOOD_WAIT_x`**
Telegram is rate-limiting you. The app already handles this: it sleeps the
requested time plus 5 seconds and retries the same chunk, and does not count it
as a failure. Frequent floods mean your throttle is too low — raise
**Settings → Throttle** to 3–5 seconds. Free accounts flood sooner than Premium.

**"Session expired" / suddenly signed out**
The stored session was invalidated — usually because you terminated the session
from another Telegram client, or changed your 2FA password. Go to
**Settings → Re-login** and sign in again.

**"Cannot find channel …" / cannot find entity**
The channel ID is wrong, or the signed-in account is not a member. The ID must
include the `-100` prefix: `-1001234567890`, not `1234567890`. Confirm with
[@userinfobot](https://t.me/userinfobot). Then open the **Topics** tab and
refresh — if it lists topics, the ID resolves.

**"Could not start the backup service" on Android 14**
Two causes. Either notification permission was denied — the service needs a
visible notification, so grant it in system settings — or the app tried to start
the service from the background, which Android 12+ forbids. Start a sync with
the app open; the scheduled job goes through WorkManager, which is allowed.

**Photos not found / scan comes back empty**
Media permissions were denied, or you are looking at a folder MediaStore does
not index. Grant **All files access** from the Home screen prompt. On Android 13+
the relevant permissions are `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO`; the
older `READ_EXTERNAL_STORAGE` does nothing there.

**Scheduled sync crashes on Android 14+ with MissingForegroundServiceTypeException**
`SyncWorker` calls `setForeground()`, but WorkManager runs that on **its own**
service — `androidx.work.impl.foreground.SystemForegroundService` — not on any
service this app declares. WorkManager's AAR declares it without a
`foregroundServiceType`, so Android 14 refuses to promote it. The manifest
overrides that entry with `tools:node="merge"` to add `dataSync`. If you ever
remove that block, the scheduled sync dies on Android 14+ while the manual
"Start Sync" keeps working, which makes it look like a WorkManager bug.

Release lint catches this (`SpecifyForegroundServiceType`); a debug build does
not, because `lintVitalRelease` only runs on release. Worth running
`./gradlew assembleRelease` after touching anything foreground-service related.

**Scheduled sync never runs**
Almost always battery optimisation. Set the app to Unrestricted, and on
Chinese-OEM devices enable Autostart. Also check that Wi-Fi-only is not on while
you are on mobile data, and that "only while charging" is not blocking it.
WorkManager will not run a periodic job more often than every 15 minutes
regardless of the configured interval.

**`Failed to get the SHA-1 for: events` when bundling**
A `require.resolve()` in `metro.config.js` returned a Node builtin id instead of
a path. Use the `pkg()` helper (trailing slash) for any module name that
collides with a Node builtin.

**Native module is undefined after editing Kotlin**
A JS reload does not rebuild native code. Run `./gradlew installDebug` again.

---

## Project layout

```
TelegramBackup/
├── android/app/src/main/
│   ├── AndroidManifest.xml            permissions, services, receivers
│   └── java/com/telegrambackup/
│       ├── MainApplication.kt          registers SyncPackage
│       └── sync/
│           ├── SyncForegroundService.kt   user-initiated sync, dataSync FGS
│           ├── SyncControlModule.kt       JS -> notification / permissions
│           ├── SyncWorker.kt              periodic job, setForeground()
│           ├── SyncHeadlessTaskService.kt runs the JS task with no UI
│           ├── SyncCoordinator.kt         worker <-> JS completion handshake
│           ├── SyncSchedulerModule.kt     WorkManager scheduling
│           ├── SyncNotifications.kt       shared notification builder
│           ├── SyncActionReceiver.kt      Pause / Resume / Stop buttons
│           ├── SyncBridge.kt              native -> JS events
│           ├── BootReceiver.kt            re-arm after reboot
│           └── SyncPackage.kt
├── shims/                             Node built-in shims for teleproto
├── src/
│   ├── App.tsx, polyfills/, navigation/
│   ├── screens/                       Login, Home, Folders, Topics, Logs, Settings
│   ├── services/
│   │   ├── telegram/  client.ts, upload.ts, topics.ts
│   │   ├── db/        schema.ts
│   │   ├── sync/      scanner.ts, router.ts, engine.ts, queue.ts
│   │   └── secure/    keychain.ts
│   ├── background/    foreground.ts, scheduler.ts
│   ├── state/store.ts, types/, utils/logger.ts
├── metro.config.js                    the Node-builtin resolver
└── package.json
```

## Useful scripts

```bash
npm run typecheck      # tsc --noEmit, strict
npm run android        # build + run on the connected device
npm run apk:debug      # assembleDebug
npm run apk:release    # assembleRelease
npm run clean:android  # gradlew clean
npm run start:reset    # Metro with a cleared cache
```

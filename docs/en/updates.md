# Updates

[Русская версия](../ru/updates.md)

Every push to `main` in this repository produces a release named `v0.1.<build>`: server images, the Android APK and the desktop apps, all with the same version. Each part updates itself from the newest release.

## Server

As the account that owns the server, open **Settings → Updates** and press the update button.

The `updater` service then:

1. reads the newest release tag of this repository;
2. writes the matching image tag (`sha-<commit>`) into `.env`, keeping the previous one;
3. pulls the new images and recreates `api`, `worker`, `web` and `supervisor`.

Database migrations run when the new `api` starts. If the new containers fail to start, the updater puts the previous image tag back.

The same can be done from a shell in the install folder:

```sh
docker compose --env-file .env -f docker-compose.images.yml pull
docker compose --env-file .env -f docker-compose.images.yml up -d
```

## Android

Open **Account** and tap **Check for updates**. If the latest release has a newer build, the button becomes **Install update v0.1.N**: the app downloads `quant.apk` and opens Android's installer. The first time, Android asks to allow installs from Quant.

The build number in the tag (`N` in `v0.1.N`) is the app's version code. Every release is signed with the same key, so it installs over the current app and keeps your data.

## Desktop

The desktop app checks the latest release on start and every hour, and shows the state in the app's update section.

- **Windows and Linux:** the update downloads in the background and installs on restart.
- **macOS:** the app is not signed with an Apple Developer ID, so macOS refuses to replace it in place. The update section offers **Download 0.1.N**, which opens the latest release in the browser: download the new `.dmg` and drag Quant into Applications again.

## Fast updates from main

The full release takes about 25 minutes, mostly for the Android build. Every push to `main` also runs the `edge` workflow, which publishes a fast update under the `edge` pre-release a few minutes after the push. A fast update carries only JavaScript, so it never replaces anything native.

- **Desktop:** **Settings → Updates → Latest from main** checks for it. The update holds the web app and the server's JavaScript, about 13 MB. The app checks its SHA-256, unpacks it next to its data, and restarts on it. Your server data, sign-in and settings stay where they are. It applies only when the installed app has the same native parts (Electron, Postgres, native modules). Otherwise the app says the newest changes need the next full release. A newer full release always replaces an older fast update.
- **Android:** **Account → Check for updates** checks the full release first, then a fast update. When one is ready, the button becomes **Install the latest fixes**. The app downloads the new JavaScript through its own Quant server and restarts on it, with no reinstall and no lost settings. It applies only when the installed APK has the same native fingerprint (`runtimeVersion`). After native changes, install the full release.

The first build that has these features still has to be installed from a full release.

## Versions

| Part | Where the version comes from |
| --- | --- |
| Release | `v0.1.<run number>` of the `release` workflow |
| Server images | Tags `v0.1.N`, `sha-<commit>`, `edge` and `latest` |
| Android | `versionName` `0.1.N`, `versionCode` `N` |
| Desktop | App version `0.1.N` |

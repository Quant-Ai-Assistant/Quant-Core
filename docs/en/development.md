# Development

[Русская версия](../ru/development.md)

Quant is a pnpm monorepo. You need Node.js 22.22.2 or newer in the 22.x line, Node.js 24.x or Node.js 26+, pnpm 9 and Docker.

## Run from source

```sh
cp .env.example .env
docker compose --env-file .env -f infra/compose/docker-compose.yml \
  -f infra/compose/docker-compose.postgres-host.yml up postgres -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm sandbox:build
pnpm dev
```

Before the first start, fill `POSTGRES_PASSWORD` (and the same value in `DATABASE_URL`), `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET` and `SANDBOX_SUPERVISOR_TOKEN` in `.env`. On macOS with Docker Desktop also set `SANDBOX_CONTROL_VIA_LOOPBACK=true`. Then open `http://127.0.0.1:5173`.

## Checks

```sh
pnpm gate   # Prisma client, Biome lint, TypeScript, unit tests
```

The `ci` workflow runs the same lint, typecheck and unit tests on every push and pull request, plus production builds, Postgres journeys and the web end-to-end suite.

## Where things live

| Path | Contents |
| --- | --- |
| `apps/web` | Web interface (React, Vite). The desktop app hosts it too. |
| `apps/api`, `apps/worker` | Server and background jobs. |
| `apps/mobile` | Android and iOS app (Expo). |
| `apps/desktop` | Desktop app (Electron). |
| `packages/contracts` | Shared types and RPC contracts. |
| `packages/core` | Shared logic for every app. |
| `packages/adapters` | Agent runtime, executor, providers. |
| `packages/db` | Prisma schema and data access. |
| `infra/compose` | Self-host Compose files, installer and gate. |
| `infra/updater` | The update sidecar. |

## Releases

`.github/workflows/release.yml` runs on every push to `main`:

1. picks the version `0.1.<run number>`;
2. builds the `app`, `updater` and `computer` images for `linux/amd64` and `linux/arm64` and pushes them to `ghcr.io/quant-ai-assistant/quant-core`;
3. builds the Android APK with Gradle and signs it with the release key from the repository secrets;
4. builds the desktop apps for macOS, Windows and Linux;
5. publishes release `v0.1.N` with all files and the installer.

The Android signing key lives in the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS`. Keep a copy outside GitHub: a lost key means the next APK cannot update installed apps.

## Upstream

Quant is a fork of [Rakazo](https://github.com/elie222/rakazo). The `upstream` remote points there:

```sh
git fetch upstream
git merge upstream/main
```

Internal package names stay `@rakazo/*` and environment variables stay `RAKAZO_*`, so merges stay small. Visible names, icons, image addresses and update sources are Quant's.

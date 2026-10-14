# Разработка

[English version](../en/development.md)

Quant — монорепозиторий на pnpm. Нужны Node.js 22.22.2 или новее в линейке 22.x, Node.js 24.x или Node.js 26+, pnpm 9 и Docker.

## Запуск из исходников

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

Перед первым запуском заполните в `.env` `POSTGRES_PASSWORD` (и то же значение в `DATABASE_URL`), `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, `SCREEN_PROXY_SECRET` и `SANDBOX_SUPERVISOR_TOKEN`. На macOS с Docker Desktop также укажите `SANDBOX_CONTROL_VIA_LOOPBACK=true`. Затем откройте `http://127.0.0.1:5173`.

## Проверки

```sh
pnpm gate   # клиент Prisma, линтер Biome, TypeScript, модульные тесты
```

Workflow `ci` запускает те же линтер, проверку типов и модульные тесты на каждый пуш и pull request, а также production-сборки, сценарии на Postgres и e2e-тесты веба.

## Где что лежит

| Путь | Содержимое |
| --- | --- |
| `apps/web` | Веб-интерфейс (React, Vite). Его же показывает десктопное приложение. |
| `apps/api`, `apps/worker` | Сервер и фоновые задачи. |
| `apps/mobile` | Приложение для Android и iOS (Expo). |
| `apps/desktop` | Десктопное приложение (Electron). |
| `packages/contracts` | Общие типы и RPC-контракты. |
| `packages/core` | Общая логика всех приложений. |
| `packages/adapters` | Среда агента, исполнитель, провайдеры. |
| `packages/db` | Схема Prisma и доступ к данным. |
| `infra/compose` | Compose-файлы для self-host, установщик и шлюз. |
| `infra/updater` | Сервис обновления. |

## Релизы

`.github/workflows/release.yml` запускается на каждый пуш в `main`:

1. выбирает версию `0.1.<номер запуска>`;
2. собирает образы `app`, `updater` и `computer` для `linux/amd64` и `linux/arm64` и публикует их в `ghcr.io/quant-ai-assistant/quant-core`;
3. собирает Android-APK через Gradle и подписывает его ключом релиза из секретов репозитория;
4. собирает десктопные приложения для macOS, Windows и Linux;
5. публикует релиз `v0.1.N` со всеми файлами и установщиком.

Ключ подписи Android хранится в секретах `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` и `ANDROID_KEY_ALIAS`. Держите его копию вне GitHub: если ключ потерян, следующий APK не сможет обновить уже установленные приложения.

## Оригинальный проект

Quant — форк [Rakazo](https://github.com/elie222/rakazo). На него указывает remote `upstream`:

```sh
git fetch upstream
git merge upstream/main
```

Внутренние имена пакетов остаются `@rakazo/*`, а переменные окружения — `RAKAZO_*`, чтобы слияния были небольшими. Видимые названия, иконки, адреса образов и источники обновлений — Quant.

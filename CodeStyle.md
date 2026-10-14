# Code style

The mandatory standard for Quant, for human developers and AI agents alike. Read it before implementing anything and cite rule numbers in reviews ("violates S12"). [`AGENTS.md`](AGENTS.md) carries the same rules in the upstream wording plus the workflow around them.

## Product boundaries

- **S1.** Quant is one product across web, Electron desktop and Expo mobile. Put shared behavior, contracts, API logic and reusable UI in `packages/`. Keep only genuinely native navigation, storage, permissions and interactions platform-specific.
- **S2.** A core workflow covers every applicable surface or degrades safely for a reason stated in the code.
- **S3.** No hosted vendor is required to run the product. Models, sandboxes, memory, voice and integrations stay optional and behind provider-neutral interfaces; vendor SDKs live only in adapters and composition roots.
- **S4.** Frontends express intent and render state. The backend owns orchestration, authorization, validation, retries, recovery and provider translation.
- **S5.** Compatible providers and models are configured through shared connection settings. Never add a provider- or model-specific environment variable when the generic connection can express it.

## Code

- **S6.** Keep code simple: reuse existing primitives, keep one source of truth, remove duplication and unused flexibility. Add an interface only where it protects a real external or platform boundary.
- **S7.** Use top-level `import type`, never inline type imports. Use dynamic `import()` only for necessary deferred loading.
- **S8.** Match the surrounding code: naming, comment density and idiom. Comments say why, not what.
- **S9.** Biome formats and lints everything. `pnpm gate` must pass before a push.

## Interface and copy

- **S10.** Treat every visible word as UI. Start UX work by asking what can be removed; prefer progressive disclosure over persistent explanation or status chrome.
- **S11.** Give controls concise accessible names. Icon-only buttons always have one.
- **S12.** Every new user-facing string is translated through the app's catalog: Lingui for web (`pnpm --filter @rakazo/web intl:extract`), `apps/mobile/lib/locales/*.ts` for mobile. Russian is always filled in.
- **S13.** Colors come from `@rakazo/ui-tokens` semantic tokens. Never hardcode a product hex or use `[var(--…)]` arbitrary values in web code.
- **S14.** Web and Electron use the vendored shadcn/ui components in `packages/ui-web` before hand-written chrome. Mobile prefers native controls (Expo UI, native headers, menus, alerts, pickers, switches).

## Security

- **S15.** Auth, secret handling, sandbox boundaries, host commands, the update sidecar and the self-host gate are security-sensitive: change them with tests and say so in the pull request.
- **S16.** Never commit secrets, `.env` files, private URLs, personal data or production data. Use placeholders such as `your-openrouter-key`.
- **S17.** Credentials never travel in URLs, logs or renderer-visible messages. Store them with the platform's secret store (SecureStore, safeStorage, the encrypted secret store).

## Tests

- **S18.** Tests are deterministic and offline by default: scripted runtime, fake sandbox, in-memory wakeup. No live provider calls outside the canary commands.
- **S19.** A behavior change comes with a test that fails without it. A UI change on the web gets an E2E path that opens the screen.
- **S20.** Do not run the desktop Playwright suite on a maintainer's machine; it opens real Electron windows. CI runs it.

## Git and pull requests

- **S21.** Work on a branch and merge into `main` through a pull request. Every push to `main` publishes a release, so `main` must always be releasable.
- **S22.** Commit with the GitHub noreply address, not a personal email.
- **S23.** Commit messages and pull requests say why the change exists, what changed and how it was tested, in plain words. They never contain local paths, usernames, hostnames, account emails or secret values.
- **S24.** A pull request that adds user-facing copy quotes it and says why it is needed and why progressive disclosure would not work.

## Quant and upstream

- **S25.** Visible names, icons, image addresses, release feeds and update sources are Quant's. Internal package names (`@rakazo/*`) and environment variables (`RAKAZO_*`) stay as they are so upstream merges stay small.
- **S26.** Rakazo code keeps its copyright notices. The project license is AGPL-3.0-or-later; `LICENSE-APACHE` stays in the repository.

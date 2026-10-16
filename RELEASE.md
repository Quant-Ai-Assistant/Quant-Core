# Release train

Every push to `main` builds and publishes a Quant release (server images, Android, desktop).
To ship several features and fixes as one release instead of one release per fix, work lands
on a release branch first and reaches `main` only when the maintainer says so.

## Current release branch

`release/0.1.21`

### In this release

| Feature | Branch | Notes |
| --- | --- | --- |
| "This Mac" settings: emergency stop, per-assistant interrupt and off switch, server on/off, don't lock the Mac | `feat/agent-controls` | Adds `Bot.pausedAt` (migration `20261016020000_bot_paused_at`). |

## How to land a feature or fix

1. Fetch and branch from the release branch above, not from `main`:
   `git fetch origin && git switch -c feat/<name> origin/release/<version>`.
2. Do the work, run `pnpm gate`.
3. Open the pull request against the release branch (`--base release/<version>`), never against
   `main`. Merge it there once checks and review are done.
4. Add a row for your work to "In this release" above, in the same pull request.
5. When your work is merged, ask the maintainer one question: ship the release branch to
   `main` now, or wait for more features? Do not merge into `main` without a yes.

## Shipping

Only on the maintainer's yes:

1. Bring the release branch up to date with `main` (merge `main` into it) and run `pnpm gate`.
2. Open a pull request from the release branch into `main` listing everything in
   "In this release", and merge it. That push publishes the release.
3. Start the next train: create `release/<next version>` from the new `main`, push it, and
   in this file replace the branch name and clear "In this release".

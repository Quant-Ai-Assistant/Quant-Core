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
| Mac screen in the bot panel with a built-in virtual desktop (Lima, no Docker); Telegram-style voice messages; smooth sending; Android update card; hover without clicking; "Computer" badge on replies; phone-like calls in the chat and on the call screen | `fix/voice-screen-chat-polish` | The virtual desktop downloads a pinned Lima release on first use. User messages and `thread.message.created` carry `clientNonce`; new RPC `threads.activity`. Mobile drops `expo-speech-recognition`. |
| Telegram-style message reactions: one per person, tap again to remove; 👍/👎 on the bot's latest message answers it (e.g. closes a reminder); the bot can answer with a reaction instead of text, without a typing indicator | `feat/message-reactions` | No migration: reactions stay emoji-only replies. New built-in tool `react_to_message`; `threads.react` takes `reaction: null` to remove; turns started by a reaction use the existing `reaction` run trigger. |
| Agent watches instead of polling: a bot can watch a teammate bot and is woken by each update it posts, staying silent until a key milestone; or it can watch a check command (e.g. a finished download) that the server runs without the model and is woken once when it passes or expires | `feat/agent-watches` | Adds the `watches` table and `Run.watchId` (migration `20261018010000_watches`). New built-in tools `watch_create`, `watch_list`, `watch_cancel`, run trigger `watch` and background job `watch.check`. |
| Hanging up a bot's call on the phone stops it ringing on the other devices | `fix/call-decline-sync` | The phone sent no `outcome`, so the server rejected the hang-up; `threads.declineCall` now defaults it to `declined`, which also fixes Android builds already installed. |
| Alarm-like reminders: when a reminder comes due the bot rings the phone (waking it full screen on Android, even locked) and the desktop with the text and **Done** / **In 5 minutes**; answering on one device stops it on the others; the chat keeps a card with its state | `feat/reminders` | No migration: a reminder is a bot message with a new `reminder` block. New built-in tool `remind_user`, RPCs `threads.ringingReminders` and `threads.settleReminder`, background job `reminder.tick`. The Android background service now runs whenever the user is signed in, not only when calls are on. |
| Claude Code for bots: sign in once in **Settings → Claude Code** (Claude subscription or API key, kept apart from chat models); turn it on per bot with its own model and effort; coding work then runs through the real `claude` CLI on the bot's computer, with a live card of its steps in the chat, the step in the call badge, and `/Claude Code` to send one request through it. Every tool now reports a shared status (reading a file, running tests, …) that the chat, calls and the phone word in their own language | `feat/claude-code` | Adds `Bot.claudeCodeEnabled`, `claudeCodeModel`, `claudeCodeEffort` and the `user_claude_code` table (migration `20261018020000_claude_code`). New built-in tool `claude_code`, message block `claude_code`, RPCs `claudeCode.account`, `finishSignIn`, `connectKey`, `disconnect`; `threads.activity` also returns `status`. |

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

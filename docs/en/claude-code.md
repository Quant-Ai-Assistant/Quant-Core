# Claude Code

[Русская версия](../ru/claude-code.md)

A bot can do its work on code through the Claude Code CLI instead of its own shell and file tools. The bot keeps talking on its own model; only the coding runs on Claude Code, with every Claude Code tool, subagent, skill and the project's `CLAUDE.md`.

## Sign in

Open **Settings → Claude Code** and press **Sign in with Claude** (Claude Pro or Max), or paste an Anthropic API key. This account is used only by Claude Code. It does not change the models your bots chat with.

Without a sign-in here, the CLI uses whatever sign-in the bot's computer already has, for example `claude` you signed in to yourself on this Mac.

## Turn it on for a bot

Open the bot's settings and turn on **Claude Code**. Then pick:

- **Model**: Fable, Opus, Sonnet or Haiku, or the CLI's default.
- **Effort**: Low, Medium, High, Extra high or Max, or the CLI's default.

They apply only to that bot's Claude Code runs. A bot that chats on a small model can still code on Opus with high effort.

To send one request through Claude Code, type `/` in the message field and pick **Claude Code**.

## What you see

While Claude Code works, the chat shows a **Claude Code** card with the step it is on (reading a file, editing a file, running tests, searching the web) and the latest steps. When it finishes, the card folds to the number of steps and the time it took; tap it to see every step.

In a call, the badge under the bot's name shows the same step, for example **Claude Code · Editing a file**.

## The computer

Claude Code runs on the bot's computer, in the bot's folder unless the bot names a project folder. If the computer does not have the CLI, the bot is told to install it with `curl -fsSL https://claude.ai/install.sh | bash`.

Claude Code runs without asking for permission on each step, because the bot can already run any command on its computer. Use a separate computer for work that must stay isolated.

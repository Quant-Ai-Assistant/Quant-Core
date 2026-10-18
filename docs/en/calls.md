# Calls and voice

[Русская версия](../ru/calls.md)

Voice in Quant needs a voice provider: connect one in **Settings → Voice** with your own key (ElevenLabs, OpenAI, Cartesia or Fish Audio). Without one, the call button opens those settings.

## Calling a bot

Press the phone button at the top right of a chat.

1. The call window rings until the microphone is ready.
2. Once connected it shows a timer and what the bot is doing: listening, thinking or speaking.
3. The controls are mute, camera, screen sharing, transcript, minimize and hang up.

On a computer the window floats over the chat; on a phone it fills the screen. A minimized call stays reachable from the green bar under the chat header.

Camera and screen sharing show a local preview only: the bot does not see them yet.

After the call, the chat shows a **Phone call** card with its length. Open it to read the conversation.

## Dictation

The microphone button next to **Send** turns speech into a message.

- **Hold, talk, release:** the text is sent when you let go.
- **Slide up while holding:** the recording locks; then press **Send recording** or **Discard recording**.
- **Keyboard:** Tab to the button and press Enter or Space to start a locked recording.

If sending fails, the recognized text stays in the message field.

## When the bot calls you

A bot can call you with its `call_user` tool:

- when you ask it to ("call me at 18:30 about the report");
- when it reminded you about the same thing three times and you did not reply.

The incoming call rings on any open Quant screen, shows why the bot is calling, and offers **Answer**, **Decline** and **Remind me in 10 minutes**. When you answer, the bot speaks first. If you decline or miss it, the chat shows a missed call with **Call back**, and the bot sees the outcome in its history. **Remind me in 10 minutes** schedules the bot to try again.

Limits:

- one call at a time: a bot can ring again as soon as the previous call stops ringing;
- no calls in group chats, from messaging channels or during another call;
- a call rings for 45 seconds before it counts as missed;
- an app or tab that is closed cannot ring: the missed call waits in the chat.

To stop a bot from calling, open its settings and add `call_user` to the disabled tools.

## Reminders

When a reminder you asked for comes due ("remind me at 14:30 to call the bank"), the bot rings your devices with its `remind_user` tool, like an alarm:

- on Android the reminder wakes the phone, even locked, and shows its text full screen; with the phone in use it appears as a notification at the top;
- on a computer or in a browser tab it appears in the corner of Quant.

Press **Done** or **In 5 minutes**. Answering on one device stops the reminder on the others. A snoozed reminder rings again five minutes later. A reminder nobody answers rings for a minute, comes back five minutes later, and after three unanswered rings counts as missed; the bot sees that in its history and may call you.

The chat keeps a card for every reminder with where it stands: ringing, snoozed until a time, done or missed.

On Android, Quant keeps a quiet background connection with a permanent notification while you are signed in, so reminders can wake the phone. Allow **full-screen notifications** and an **unrestricted battery** when the app asks.

To stop a bot from ringing reminders, add `remind_user` to its disabled tools; its reminders then arrive as ordinary messages.

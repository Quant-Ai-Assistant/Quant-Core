import { Trans, useLingui } from "@lingui/react/macro";
import type { AvatarStyle, BotControl, DesktopHostState } from "@rakazo/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  BotAvatar,
  Button,
  Label,
  Switch,
} from "@rakazo/ui-web";
import { useCallback, useEffect, useId, useState } from "react";
import { desktopBridge } from "../lib/desktop";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

const POLL_MS = 2_000;

/**
 * The computer the desktop app runs on: its server, its screen lock, and an off switch for
 * every assistant, with one button that stops them all at once.
 */
export function HostSettingsPanel({ avatarStyle }: { avatarStyle: AvatarStyle }) {
  const host = desktopBridge()?.host;
  const [hostState, setHostState] = useState<DesktopHostState | null>(null);
  const [bots, setBots] = useState<BotControl[] | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const serverId = useId();
  const keepAwakeId = useId();

  const refreshBots = useCallback(async () => {
    setBots(await rpc.bots.controls());
  }, []);

  useEffect(() => {
    void host?.state().then(setHostState);
  }, [host]);

  useEffect(() => {
    let live = true;
    const tick = () => {
      void rpc.bots
        .controls()
        .then((next) => {
          if (live) setBots(next);
        })
        .catch(() => undefined);
    };
    tick();
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, []);

  async function act(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
      await refreshBots();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }

  const allOff = bots !== null && bots.length > 0 && bots.every((bot) => bot.paused);

  return (
    <div className="space-y-5" data-testid="host-settings">
      {bots !== null && bots.length > 0 ? (
        <section
          className={`flex items-center gap-4 rounded-xl border px-4 py-4 ${
            allOff ? "border-border" : "border-destructive/40"
          }`}
        >
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-medium text-foreground">
              {allOff ? <Trans>All assistants are off</Trans> : <Trans>Emergency stop</Trans>}
            </h3>
            <p className="text-[13px] text-muted-foreground">
              {allOff ? (
                <Trans>None of them will reply until you start them</Trans>
              ) : (
                <Trans>Interrupts whatever assistants are doing and turns them off</Trans>
              )}
            </p>
          </div>
          {allOff ? (
            <Button
              variant="outline"
              disabled={pending}
              data-testid="start-all-bots"
              onClick={() => void act(() => rpc.bots.setAllPaused({ paused: false }))}
            >
              <Trans>Start all</Trans>
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={pending}
              data-testid="stop-all-bots"
              onClick={() => setConfirmStop(true)}
            >
              <Trans>Stop all</Trans>
            </Button>
          )}
        </section>
      ) : null}

      {host && hostState ? (
        <section className="divide-y divide-border rounded-xl border border-border">
          {hostState.server ? (
            <div className="flex items-center gap-4 px-4 py-3.5">
              <Label htmlFor={serverId} className="block min-w-0 flex-1 font-normal">
                <span className="block text-[14px] text-foreground">
                  <Trans>Server</Trans>
                </span>
                <span className="block text-[12.5px] text-muted-foreground">
                  {hostState.server.port === null ? (
                    <Trans>Running</Trans>
                  ) : (
                    <Trans>Running · port {hostState.server.port}</Trans>
                  )}
                </span>
              </Label>
              <Switch
                id={serverId}
                data-testid="host-server-toggle"
                checked={hostState.server.running}
                onCheckedChange={(checked) => {
                  if (!checked) void host.stopServer();
                }}
              />
            </div>
          ) : null}
          <div className="flex items-center gap-4 px-4 py-3.5">
            <Label htmlFor={keepAwakeId} className="block min-w-0 flex-1 font-normal">
              <span className="block text-[14px] text-foreground">
                {desktopBridge()?.platform === "darwin" ? (
                  <Trans>Don't lock this Mac</Trans>
                ) : (
                  <Trans>Don't lock this computer</Trans>
                )}
              </span>
              <span className="block text-[12.5px] text-muted-foreground">
                <Trans>The screen stays on and never asks for the password</Trans>
              </span>
            </Label>
            <Switch
              id={keepAwakeId}
              data-testid="host-keep-awake-toggle"
              checked={hostState.keepAwake}
              onCheckedChange={(checked) => {
                void host.setKeepAwake(checked).then((next) => {
                  if (next) setHostState(next);
                });
              }}
            />
          </div>
        </section>
      ) : null}

      {bots !== null && bots.length > 0 ? (
        <section>
          <h3 className="mb-2 px-0.5 text-[13px] text-muted-foreground">
            <Trans>Assistants</Trans>
          </h3>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {bots.map((bot) => (
              <BotControlRow
                key={bot.id}
                bot={bot}
                avatarStyle={avatarStyle}
                disabled={pending}
                onStop={() => void act(() => rpc.bots.stop({ botId: bot.id }))}
                onPausedChange={(paused) =>
                  void act(() => rpc.bots.setPaused({ botId: bot.id, paused }))
                }
              />
            ))}
          </ul>
        </section>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}

      <AlertDialog open={confirmStop} onOpenChange={setConfirmStop}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Stop all assistants?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Their current work stops, and none of them will reply until you start them.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>No</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              data-testid="confirm-stop-all-bots"
              onClick={() => {
                setConfirmStop(false);
                void act(() => rpc.bots.setAllPaused({ paused: true }));
              }}
            >
              <Trans>Yes, stop</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function BotControlRow({
  bot,
  avatarStyle,
  disabled,
  onStop,
  onPausedChange,
}: {
  bot: BotControl;
  avatarStyle: AvatarStyle;
  disabled: boolean;
  onStop: () => void;
  onPausedChange: (paused: boolean) => void;
}) {
  const { t } = useLingui();
  const busy = !bot.paused && bot.status !== "idle";
  const status = bot.paused
    ? t`Off`
    : bot.status === "idle"
      ? t`Idle`
      : bot.status === "waiting_input" || bot.status === "waiting_takeover"
        ? t`Waiting for you`
        : t`Working…`;
  return (
    <li className="flex items-center gap-3 px-4 py-3" data-testid={`bot-control-${bot.id}`}>
      <span className={bot.paused ? "opacity-40" : undefined}>
        <BotAvatar color={bot.color} identity={bot.id} size={28} variant={avatarStyle} />
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={`truncate text-[14px] ${bot.paused ? "text-muted-foreground" : "text-foreground"}`}
        >
          {bot.name}
        </p>
        <p className="text-[12.5px] text-muted-foreground">{status}</p>
      </div>
      {busy ? (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onStop}>
          <Trans>Interrupt</Trans>
        </Button>
      ) : null}
      <Switch
        aria-label={bot.name}
        checked={!bot.paused}
        disabled={disabled}
        onCheckedChange={(checked) => onPausedChange(!checked)}
      />
    </li>
  );
}

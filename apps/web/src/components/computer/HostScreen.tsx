import { useLingui } from "@lingui/react/macro";
import type { ComputerMode } from "@rakazo/contracts";
import { cn, Tabs, TabsList, TabsTrigger } from "@rakazo/ui-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { desktopBridge } from "../../lib/desktop";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

/** How often the panel asks for a new picture of the host screen. */
export const HOST_FRAME_INTERVAL_MS = 1_000;

/** The host screen a bot works on, refreshed while the page is visible. */
export function HostScreen({
  botId,
  className,
  noScreen,
}: {
  botId: string;
  className?: string;
  /** Shown when this host has no screen driver (only macOS has one). */
  noScreen: ReactNode;
}) {
  const { t } = useLingui();
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = async () => {
      if (cancelled) return;
      if (typeof document === "undefined" || document.visibilityState === "visible") {
        try {
          const { imageBase64 } = await rpc.computer.screenFrame({ botId });
          if (cancelled) return;
          setFrame(`data:image/jpeg;base64,${imageBase64}`);
          setError(null);
        } catch (failure) {
          if (cancelled) return;
          if (hasCode(failure, "NOT_FOUND")) {
            setMissing(true);
            return;
          }
          setError(errorText(failure, t`Could not show this screen`));
        }
      }
      if (!cancelled) timer = setTimeout(next, HOST_FRAME_INTERVAL_MS);
    };
    void next();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [botId, t]);

  if (frame) {
    return (
      <img
        src={frame}
        alt={t`Bot screen preview`}
        data-testid="host-screen"
        className={cn("h-full w-full bg-black object-contain", className)}
      />
    );
  }
  return (
    <div
      className={cn(
        "grid h-full place-items-center px-6 text-center text-sm text-muted-foreground/80",
        className,
      )}
    >
      {missing ? noScreen : error}
    </div>
  );
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

/** The name of the machine the app runs on, as the panel shows it. */
export function useHostLabel(): string {
  const { t } = useLingui();
  return desktopBridge()?.platform === "darwin" ? t`This Mac` : t`This computer`;
}

/** Switches a bot between the shared host screen (team) and its own virtual desktop. */
export function ComputerPlaceSwitch({
  botId,
  mode,
  onSwitched,
}: {
  botId: string;
  mode: ComputerMode;
  onSwitched: () => Promise<void> | void;
}) {
  const { t } = useLingui();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = useHostLabel();

  async function choose(next: ComputerMode) {
    if (next === mode || pending) return;
    setPending(true);
    setError(null);
    try {
      await rpc.bots.setComputer({ botId, mode: next });
      await onSwitched();
    } catch (failure) {
      setError(errorText(failure, t`Could not switch the computer`));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Tabs value={mode} onValueChange={(value) => void choose(value as ComputerMode)}>
        <TabsList aria-label={t`Where this bot works`}>
          <TabsTrigger value="team" disabled={pending}>
            {host}
          </TabsTrigger>
          <TabsTrigger value="dedicated" disabled={pending}>
            {t`Virtual`}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {error ? (
        <span role="alert" className="text-[12px] text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}

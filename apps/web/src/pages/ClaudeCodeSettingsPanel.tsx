import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { ClaudeCodeAccount } from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import { rpc } from "../lib/rpc";
import { useModelOAuthSignIn } from "../lib/use-model-oauth-signin";
import { errorText } from "../lib/user-error";

/** Claude's sign-in provider; the same flow as chat models, saved for Claude Code only. */
const CLAUDE_PROVIDER = "anthropic";

/**
 * The Claude account bots use when they run the Claude Code CLI. It is separate from the chat
 * model connections, so signing in here never changes which model the bots talk with.
 */
export function ClaudeCodeSettingsPanel({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useLingui();
  const apiKeyId = useId();
  const [account, setAccount] = useState<ClaudeCodeAccount | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"key" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    oauth,
    pasteCode,
    setPasteCode,
    oauthPending,
    popupBlocked,
    cancelOAuthAttempt,
    startSubscriptionSignIn,
    submitOAuthCode,
  } = useModelOAuthSignIn({
    onClearError: () => setError(null),
    onError: setError,
    finish: async (loginId, signal) => {
      setAccount(await rpc.claudeCode.finishSignIn({ loginId }, { signal }));
    },
    onFinished: () => undefined,
  });
  const busy = pending !== null || oauthPending;

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  useEffect(() => {
    void rpc.claudeCode
      .account()
      .then(setAccount)
      .catch((err: unknown) => setError(errorText(err, t`Could not load Claude Code`)));
  }, []);

  async function run(kind: "key" | "disconnect", work: () => Promise<ClaudeCodeAccount>) {
    setPending(kind);
    setError(null);
    try {
      setAccount(await work());
      return true;
    } catch (err) {
      setError(errorText(err, t`Could not save`));
      return false;
    } finally {
      setPending(null);
    }
  }

  return (
    <div data-testid="claude-code-settings">
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      {account?.connected ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-foreground">
            {account.kind === "api_key" ? (
              <Trans>Using an Anthropic API key</Trans>
            ) : (
              <Trans>Signed in with Claude</Trans>
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run("disconnect", () => rpc.claudeCode.disconnect())}
          >
            {pending === "disconnect" ? <Trans>Disconnecting…</Trans> : <Trans>Disconnect</Trans>}
          </Button>
        </div>
      ) : null}

      {oauth?.mode === "auth-url" ? (
        <div className="mt-4 rounded-xl border border-border px-4 py-3 first:mt-0">
          <p className="text-sm leading-[1.5] text-muted-foreground">
            {popupBlocked ? (
              <Trans>
                Open{" "}
                <a
                  href={oauth.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline"
                >
                  {new URL(oauth.verificationUri).hostname}
                </a>{" "}
                to finish signing in.
              </Trans>
            ) : (
              <Trans>
                Finish signing in at{" "}
                <a
                  href={oauth.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline"
                >
                  {new URL(oauth.verificationUri).hostname}
                </a>
                . The final page may not load; paste its URL or code here.
              </Trans>
            )}
          </p>
          <div className="mt-3 flex items-center gap-2">
            <Input
              value={pasteCode}
              onChange={(e) => setPasteCode(e.target.value)}
              aria-label={t`Authorization code or callback URL`}
              autoComplete="off"
              spellCheck={false}
              placeholder="http://localhost:53692/callback?code=…"
              className="text-foreground md:text-[13px]"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!pasteCode.trim()}
              onClick={() => void submitOAuthCode()}
            >
              <Trans>Submit</Trans>
            </Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            <Plural
              value={Math.ceil(oauth.expiresInSeconds / 60)}
              one="Waiting for sign-in — the link expires in about # minute."
              other="Waiting for sign-in — the link expires in about # minutes."
            />
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-2 -ml-2 text-muted-foreground"
            onClick={() => cancelOAuthAttempt()}
          >
            <Trans>Cancel</Trans>
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          className="mt-4 first:mt-0"
          variant={account?.connected ? "outline" : "default"}
          disabled={busy}
          onClick={() =>
            void startSubscriptionSignIn({ provider: CLAUDE_PROVIDER, label: "Claude Code" })
          }
        >
          {oauthPending ? (
            <Trans>Starting…</Trans>
          ) : account?.connected ? (
            <Trans>Sign in again</Trans>
          ) : (
            <Trans>Sign in with Claude</Trans>
          )}
        </Button>
      )}

      <Field className="mt-6">
        <FieldLabel htmlFor={apiKeyId}>
          <Trans>Or use an Anthropic API key</Trans>
        </FieldLabel>
        <Input
          id={apiKeyId}
          type="password"
          autoComplete="new-password"
          value={apiKey}
          disabled={!account}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={t`Paste your API key`}
        />
      </Field>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3"
        disabled={busy || apiKey.trim().length < 8}
        onClick={() =>
          void run("key", () => rpc.claudeCode.connectKey({ apiKey: apiKey.trim() })).then(
            (saved) => {
              if (saved) setApiKey("");
            },
          )
        }
      >
        {pending === "key" ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
      </Button>
    </div>
  );
}

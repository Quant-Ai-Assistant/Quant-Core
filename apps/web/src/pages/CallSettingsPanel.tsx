import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CallSettings,
  ModelCatalogEntry,
  ModelCredential,
  ThinkingLevel,
} from "@rakazo/contracts";
import { Button, Field, FieldLabel, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useEffect, useId, useState } from "react";
import {
  connectedModelOptions,
  modelOptionKey,
  parseModelOptionKey,
  thinkingLevelLabel,
} from "../lib/model-catalog";
import { rpc } from "../lib/rpc";
import { errorText } from "../lib/user-error";

/**
 * Calls run on OpenAI GPT-Live with their own key, which may differ from the voice provider's.
 * Tasks the bot does during a call run on the model chosen here.
 */
export function CallSettingsPanel({ onBusyChange }: { onBusyChange?: (busy: boolean) => void }) {
  const { t } = useLingui();
  const apiKeyId = useId();
  const modelId = useId();
  const effortId = useId();
  const [settings, setSettings] = useState<CallSettings | null>(null);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"connect" | "disconnect" | "model" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = pending !== null;

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => {
    void Promise.all([rpc.calls.settings(), rpc.models.credentials(), rpc.models.list()])
      .then(([nextSettings, nextCredentials, nextCatalog]) => {
        setSettings(nextSettings);
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
      })
      .catch((err: unknown) => setError(errorText(err, t`Could not load call settings`)));
  }, []);

  async function run(kind: "connect" | "disconnect" | "model", work: () => Promise<CallSettings>) {
    setPending(kind);
    onBusyChange?.(true);
    setError(null);
    try {
      setSettings(await work());
      return true;
    } catch (err) {
      setError(errorText(err, t`Could not save call settings`));
      return false;
    } finally {
      setPending(null);
      onBusyChange?.(false);
    }
  }

  async function connect() {
    if (await run("connect", () => rpc.calls.connect({ apiKey: apiKey.trim() }))) setApiKey("");
  }

  const modelOptions = connectedModelOptions(credentials, catalog);
  const modelKey =
    settings?.modelProvider && settings.modelId
      ? modelOptionKey(settings.modelProvider, settings.modelId)
      : "";
  const selectedModel = modelKey ? parseModelOptionKey(modelKey) : null;
  const selectedEntry = catalog.find(
    (entry) => entry.provider === selectedModel?.provider && entry.id === selectedModel?.modelId,
  );
  const selectedCredential = credentials.find(
    (entry) =>
      entry.provider === selectedModel?.provider && entry.modelId === selectedModel?.modelId,
  );
  const effortOptions = (
    selectedCredential?.thinkingLevels ??
    selectedEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");
  const defaultEffort = selectedCredential?.thinkingLevel ?? "medium";

  function saveModel(next: { key: string; thinkingLevel: string }) {
    const model = next.key ? parseModelOptionKey(next.key) : null;
    void run("model", () =>
      rpc.calls.setModel({
        modelProvider: model?.provider ?? null,
        modelId: model?.modelId ?? null,
        thinkingLevel: model && next.thinkingLevel ? (next.thinkingLevel as ThinkingLevel) : null,
      }),
    );
  }

  return (
    <div
      data-testid="call-settings"
      className="rk-scroll min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8"
    >
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      <Field>
        <FieldLabel htmlFor={apiKeyId}>
          <Trans>OpenAI API key</Trans>
        </FieldLabel>
        <Input
          id={apiKeyId}
          type="password"
          autoComplete="new-password"
          value={apiKey}
          disabled={!settings}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={settings?.connected ? t`Paste a replacement key` : t`Paste your API key`}
        />
      </Field>
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          disabled={busy || apiKey.trim().length < 8}
          onClick={() => void connect()}
        >
          {pending === "connect" ? (
            <Trans>Connecting…</Trans>
          ) : settings?.connected ? (
            <Trans>Replace key</Trans>
          ) : (
            <Trans>Connect</Trans>
          )}
        </Button>
        {settings?.connected ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run("disconnect", () => rpc.calls.disconnect())}
          >
            {pending === "disconnect" ? <Trans>Disconnecting…</Trans> : <Trans>Disconnect</Trans>}
          </Button>
        ) : null}
      </div>

      {settings?.connected ? (
        <>
          <Field className="mt-6">
            <FieldLabel htmlFor={modelId}>
              <Trans>Model for tasks</Trans>
            </FieldLabel>
            <NativeSelect
              id={modelId}
              className="w-full"
              value={modelKey}
              disabled={busy}
              onChange={(event) => saveModel({ key: event.target.value, thinkingLevel: "" })}
            >
              <NativeSelectOption value="">{t`Bot's model`}</NativeSelectOption>
              {modelKey && !modelOptions.some((option) => option.key === modelKey) ? (
                <NativeSelectOption value={modelKey}>
                  {selectedModel?.modelId ?? modelKey}
                </NativeSelectOption>
              ) : null}
              {modelOptions.map((option) => (
                <NativeSelectOption key={option.key} value={option.key}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          {modelKey && effortOptions.length ? (
            <Field className="mt-6">
              <FieldLabel htmlFor={effortId}>
                <Trans>Reasoning effort</Trans>
              </FieldLabel>
              <NativeSelect
                id={effortId}
                className="w-full"
                value={settings.thinkingLevel ?? ""}
                disabled={busy}
                onChange={(event) =>
                  saveModel({ key: modelKey, thinkingLevel: event.target.value })
                }
              >
                <NativeSelectOption value="">
                  {t`Default (${thinkingLevelLabel(defaultEffort)})`}
                </NativeSelectOption>
                {effortOptions.map((level) => (
                  <NativeSelectOption key={level} value={level}>
                    {thinkingLevelLabel(level)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

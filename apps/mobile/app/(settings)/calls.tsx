import type { CallSettings, ThinkingLevel } from "@rakazo/contracts";
import { connectedModelChoices, modelOptionKey, parseModelOptionKey } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MenuPickerChoice } from "../../components/menu-picker";
import { MenuPicker } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import type { MobileModel, MobileModelCredential } from "../../lib/api";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { syncIncomingCalls } from "../../lib/incoming-calls";
import { native, useThemedStyles } from "../../lib/native";
import { thinkingLevelLabel } from "../../lib/thinking-level";
import { errorText } from "../../lib/user-error";

/**
 * Calls run on OpenAI GPT-Live with their own key, which may differ from the voice provider's.
 * Tasks the bot does during a call run on the model chosen here.
 */
export default function CallSettingsScreen() {
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [settings, setSettings] = useState<CallSettings | null>(null);
  const [credentials, setCredentials] = useState<MobileModelCredential[]>([]);
  const [catalog, setCatalog] = useState<MobileModel[]>([]);
  const [apiKey, setApiKey] = useState("");
  const [pending, setPending] = useState<"connect" | "disconnect" | "model" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void Promise.all([
        rpc<CallSettings>("calls/settings"),
        rpc<MobileModelCredential[]>("models/credentials"),
        rpc<MobileModel[]>("models/list"),
      ])
        .then(([nextSettings, nextCredentials, nextCatalog]) => {
          setSettings(nextSettings);
          setCredentials(nextCredentials);
          setCatalog(nextCatalog);
        })
        .catch((err: unknown) => setError(errorText(err, t("Could not load call settings"))));
    }, [t]),
  );

  async function save(
    kind: "connect" | "disconnect" | "model",
    work: () => Promise<CallSettings>,
  ): Promise<boolean> {
    setPending(kind);
    setError(null);
    try {
      const next = await work();
      setSettings(next);
      // A connected key is what lets bots ring this phone.
      if (kind !== "model") void syncIncomingCalls().catch(() => undefined);
      return true;
    } catch (err) {
      setError(errorText(err, t("Could not save call settings")));
      return false;
    } finally {
      setPending(null);
    }
  }

  async function connect() {
    const key = apiKey.trim();
    if (key.length < 8) return;
    if (await save("connect", () => rpc<CallSettings>("calls/connect", { apiKey: key }))) {
      setApiKey("");
    }
  }

  const modelKey =
    settings?.modelProvider && settings.modelId
      ? modelOptionKey(settings.modelProvider, settings.modelId)
      : "";
  const selected = modelKey ? parseModelOptionKey(modelKey) : null;
  const options = useMemo(
    () => connectedModelChoices(credentials, catalog),
    [catalog, credentials],
  );
  const modelChoices: MenuPickerChoice[] = [
    { key: "", label: t("Bot's model") },
    ...(modelKey && !options.some((option) => option.key === modelKey)
      ? [{ key: modelKey, label: selected?.modelId ?? modelKey }]
      : []),
    ...options.map((option) => ({ key: option.key, label: option.label })),
  ];
  const entry = catalog.find(
    (item) => item.provider === selected?.provider && item.id === selected?.modelId,
  );
  const credential = credentials.find(
    (item) => item.provider === selected?.provider && item.modelId === selected?.modelId,
  );
  const efforts = (credential?.thinkingLevels ?? entry?.thinkingLevels ?? []).filter(
    (level) => level !== "off",
  );
  const effortChoices: MenuPickerChoice[] = [
    {
      key: "",
      label: t("Default ({level})", {
        level: thinkingLevelLabel(credential?.thinkingLevel ?? "medium", t),
      }),
    },
    ...efforts.map((level) => ({ key: level, label: thinkingLevelLabel(level, t) })),
  ];

  function chooseModel(key: string, thinkingLevel: string) {
    if (pending !== null) return;
    const model = key ? parseModelOptionKey(key) : null;
    void save("model", () =>
      rpc<CallSettings>("calls/setModel", {
        modelProvider: model?.provider ?? null,
        modelId: model?.modelId ?? null,
        thinkingLevel: model && thinkingLevel ? (thinkingLevel as ThinkingLevel) : null,
      }),
    );
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {!settings && !error ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Text style={styles.fieldLabel}>{t("OpenAI API key")}</Text>
        <TextInput
          accessibilityLabel={t("OpenAI API key")}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          importantForAutofill="no"
          editable={settings !== null}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={settings?.connected ? t("Paste a replacement key") : t("Paste your API key")}
          placeholderTextColor={native.tertiaryLabel}
          secureTextEntry
          style={styles.input}
          textContentType="none"
        />
        <NativeActionButton
          disabled={pending !== null || apiKey.trim().length < 8}
          label={settings?.connected ? t("Replace key") : t("Connect")}
          onPress={() => void connect()}
        />
        {settings?.connected ? (
          <>
            <NativeActionButton
              disabled={pending !== null}
              label={pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
              onPress={() => void save("disconnect", () => rpc<CallSettings>("calls/disconnect"))}
              prominence="destructive"
            />
            <View style={styles.group}>
              <MenuPicker
                choices={modelChoices}
                label={t("Model for tasks")}
                onChange={(key) => {
                  if (key !== modelKey) chooseModel(key, "");
                }}
                value={modelKey}
              />
              {modelKey && efforts.length ? (
                <MenuPicker
                  choices={effortChoices}
                  divider
                  label={t("Reasoning effort")}
                  onChange={(level) => {
                    if (level !== (settings.thinkingLevel ?? "")) chooseModel(modelKey, level);
                  }}
                  value={settings.thinkingLevel ?? ""}
                />
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 10 },
    error: { color: tokens.destructive, marginBottom: 8 },
    fieldLabel: { color: native.label },
    input: {
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    group: {
      marginTop: 12,
      borderRadius: 14,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
  });
}

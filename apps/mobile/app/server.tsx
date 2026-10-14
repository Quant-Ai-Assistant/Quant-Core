import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../components/native-action-button";
import { cancelHeaderOptions, trailingHeaderOptions } from "../components/sheet-header";
import {
  apiBaseWarning,
  currentApiBase,
  defaultApiBase,
  normalizeApiBase,
  probeApiBase,
  resetApiBase,
  saveApiBase,
  usesCustomApiBase,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { currentServerAccess } from "../lib/server-access";
import { saveServerAccess } from "../lib/server-access-store";
import { useMobileTokens } from "../lib/native";

export default function ServerScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const current = currentApiBase();
  const [draft, setDraft] = useState(current);
  const savedAccess = currentServerAccess(current);
  const [username, setUsername] = useState(savedAccess?.username ?? "");
  const [password, setPassword] = useState(savedAccess?.password ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  const saving = useRef(false);

  useEffect(() => {
    return () => {
      active.current = false;
    };
  }, []);

  function close() {
    if (!active.current) return;
    active.current = false;
    if (router.canGoBack()) router.back();
    else router.replace("/sign-in");
  }

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;

  async function save() {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      // Basic Auth for the server's gate; both empty means the server has none.
      const access = username.trim() ? { username: username.trim(), password } : null;
      const probed = await probeApiBase(draft, fetch, access);
      if (!active.current) return;
      if (!probed.ok) {
        setError(probed.error);
        return;
      }
      const saved = await saveApiBase(probed.url);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      await saveServerAccess(saved.url, access);
      close();
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  async function restoreDefault() {
    if (saving.current) return;
    saving.current = true;
    setPending(true);
    setError(null);
    try {
      const saved = await resetApiBase();
      if (!active.current) return;
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      await saveServerAccess(saved.url, null);
      close();
    } finally {
      saving.current = false;
      setPending(false);
    }
  }

  return (
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: tokens.background }}>
      <Stack.Screen
        options={{
          title: t("Server"),
          ...cancelHeaderOptions(t("Cancel"), close),
          ...trailingHeaderOptions(
            pending ? t("Checking…") : t("Save"),
            () => void save(),
            pending,
          ),
        }}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ paddingHorizontal: 24, paddingTop: 12, paddingBottom: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={{ color: tokens.mutedForeground, fontSize: 15, lineHeight: 22 }}>
            {t("Enter your Quant server address.")}
          </Text>
          <TextInput
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={(value) => {
              setDraft(value);
              setError(null);
            }}
            onSubmitEditing={() => void save()}
            placeholder={defaultApiBase()}
            placeholderTextColor={tokens.mutedForeground}
            returnKeyType="go"
            style={{
              marginTop: 20,
              backgroundColor: tokens.muted,
              borderRadius: 13,
              padding: 16,
              color: tokens.foreground,
              fontSize: 16,
            }}
            textContentType="URL"
            value={draft}
          />
          <Text style={{ color: tokens.mutedForeground, marginTop: 24, fontSize: 13 }}>
            {t("Username and password, if the server asks for them")}
          </Text>
          <TextInput
            accessibilityLabel={t("Username")}
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect={false}
            onChangeText={(value) => {
              setUsername(value);
              setError(null);
            }}
            placeholder={t("Username")}
            placeholderTextColor={tokens.mutedForeground}
            style={{
              marginTop: 8,
              backgroundColor: tokens.muted,
              borderRadius: 13,
              padding: 16,
              color: tokens.foreground,
              fontSize: 16,
            }}
            textContentType="username"
            value={username}
          />
          <TextInput
            accessibilityLabel={t("Password")}
            autoCapitalize="none"
            autoComplete="password"
            autoCorrect={false}
            onChangeText={(value) => {
              setPassword(value);
              setError(null);
            }}
            onSubmitEditing={() => void save()}
            placeholder={t("Password")}
            placeholderTextColor={tokens.mutedForeground}
            returnKeyType="go"
            secureTextEntry
            style={{
              marginTop: 8,
              backgroundColor: tokens.muted,
              borderRadius: 13,
              padding: 16,
              color: tokens.foreground,
              fontSize: 16,
            }}
            textContentType="password"
            value={password}
          />
          {warning ? (
            <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
              {warning}
            </Text>
          ) : null}
          {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
          {usesCustomApiBase(current) || draft.trim() !== current ? (
            <NativeActionButton
              disabled={pending}
              label={t("Use default server")}
              onPress={() => void restoreDefault()}
              prominence="plain"
              style={{ marginTop: 28, alignSelf: "center" }}
            />
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

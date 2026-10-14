import { Stack, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { AppMark } from "../components/app-mark";
import { NativeActionButton } from "../components/native-action-button";
import {
  apiBaseWarning,
  currentApiBase,
  defaultApiBase,
  hasBuiltInApiBase,
  needsServerSetup,
  normalizeApiBase,
  probeApiBase,
  resetApiBase,
  saveApiBase,
  usesCustomApiBase,
} from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { currentServerAccess } from "../lib/server-access";
import { saveServerAccess } from "../lib/server-access-store";

const EXAMPLE_SERVER = "http://192.168.1.10:8080";

/** Connects the app to a Quant server: check it first, then continue to sign-in. */
export default function ServerScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const current = currentApiBase();
  // First launch of a build without a built-in server: nothing to go back to.
  const [setup] = useState(needsServerSetup);
  const [draft, setDraft] = useState(setup ? "" : current);
  const savedAccess = currentServerAccess(current);
  const [username, setUsername] = useState(savedAccess?.username ?? "");
  const [password, setPassword] = useState(savedAccess?.password ?? "");
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const active = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    return () => {
      active.current = false;
    };
  }, []);

  function close() {
    if (!active.current) return;
    active.current = false;
    if (!setup && router.canGoBack()) router.back();
    else router.replace("/sign-in");
  }

  function edit(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setError(null);
      setVerified(null);
    };
  }

  const parsedDraft = normalizeApiBase(draft);
  const warning = parsedDraft.ok ? apiBaseWarning(parsedDraft.url) : null;
  // Basic Auth for the server's gate; an empty username means the server has none.
  const access = username.trim() ? { username: username.trim(), password } : null;

  async function run(task: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await task();
    } finally {
      busy.current = false;
      if (active.current) setPending(false);
    }
  }

  function check() {
    return run(async () => {
      const probed = await probeApiBase(draft, fetch, access);
      if (!active.current) return;
      if (probed.ok) setVerified(probed.url);
      else setError(probed.error);
    });
  }

  function connect(url: string) {
    return run(async () => {
      const saved = await saveApiBase(url);
      if (!active.current) return;
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      await saveServerAccess(saved.url, access);
      close();
    });
  }

  function restoreDefault() {
    return run(async () => {
      const saved = await resetApiBase();
      if (!active.current) return;
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      await saveServerAccess(saved.url, null);
      close();
    });
  }

  function submit() {
    if (verified) void connect(verified);
    else if (draft.trim()) void check();
  }

  const fieldStyle = {
    backgroundColor: tokens.muted,
    borderRadius: 13,
    padding: 16,
    color: tokens.foreground,
    fontSize: 16,
  } as const;

  return (
    <SafeAreaView
      edges={setup ? ["top", "bottom"] : ["bottom"]}
      style={{ flex: 1, backgroundColor: tokens.background }}
    >
      <Stack.Screen options={{ headerShown: !setup, title: t("Server") }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: setup ? "center" : "flex-start",
            paddingHorizontal: 24,
            paddingVertical: 24,
          }}
          keyboardShouldPersistTaps="handled"
        >
          {setup ? (
            <>
              <AppMark />
              <Text
                accessibilityRole="header"
                style={{
                  color: tokens.foreground,
                  fontSize: 28,
                  fontWeight: "500",
                  textAlign: "center",
                  marginTop: 16,
                  marginBottom: 12,
                }}
              >
                {t("Connect to your server")}
              </Text>
            </>
          ) : null}
          <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
            {t("Server address")}
          </Text>
          <TextInput
            accessibilityLabel={t("Server address")}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            keyboardType="url"
            onChangeText={edit(setDraft)}
            onSubmitEditing={submit}
            placeholder={hasBuiltInApiBase() ? defaultApiBase() : EXAMPLE_SERVER}
            placeholderTextColor={tokens.mutedForeground}
            returnKeyType="next"
            style={{ ...fieldStyle, marginTop: 8 }}
            textContentType="URL"
            value={draft}
          />
          <Text style={{ color: tokens.mutedForeground, marginTop: 20, fontSize: 13 }}>
            {t("Username and password, if the server asks for them")}
          </Text>
          <TextInput
            accessibilityLabel={t("Username")}
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect={false}
            onChangeText={edit(setUsername)}
            placeholder={t("Username")}
            placeholderTextColor={tokens.mutedForeground}
            style={{ ...fieldStyle, marginTop: 8 }}
            textContentType="username"
            value={username}
          />
          <TextInput
            accessibilityLabel={t("Password")}
            autoCapitalize="none"
            autoComplete="password"
            autoCorrect={false}
            onChangeText={edit(setPassword)}
            onSubmitEditing={submit}
            placeholder={t("Password")}
            placeholderTextColor={tokens.mutedForeground}
            returnKeyType="go"
            secureTextEntry
            style={{ ...fieldStyle, marginTop: 8 }}
            textContentType="password"
            value={password}
          />
          {warning ? (
            <Text style={{ color: tokens.mutedForeground, marginTop: 12, fontSize: 13 }}>
              {warning}
            </Text>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={{ color: tokens.destructive, marginTop: 12 }}>
              {error}
            </Text>
          ) : null}
          {verified ? (
            <Text accessibilityRole="alert" style={{ color: tokens.success, marginTop: 12 }}>
              {t("Connected")}
            </Text>
          ) : null}
          <NativeActionButton
            busy={pending}
            disabled={!draft.trim()}
            label={verified ? t("Continue") : t("Check connection")}
            onPress={submit}
            style={{ marginTop: 16 }}
          />
          {hasBuiltInApiBase() && (usesCustomApiBase(current) || draft.trim() !== current) ? (
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

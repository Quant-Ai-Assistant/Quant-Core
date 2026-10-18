import type { ClaudeCodeAccount, ModelOAuthBegin } from "@rakazo/contracts";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { NativeActionButton } from "../../components/native-action-button";
import { rpc } from "../../lib/api";
import { mobileTokens } from "../../lib/appearance";
import { useI18n } from "../../lib/i18n";
import { cancelModelOAuthAttempt, waitForModelOAuth } from "../../lib/model-auth";
import { native, useThemedStyles } from "../../lib/native";
import { errorText } from "../../lib/user-error";

/**
 * The Claude account bots use when they run the Claude Code CLI. It is kept apart from the chat
 * models, so signing in here never changes which model the bots talk with.
 */
export default function ClaudeCodeSettingsScreen() {
  const styles = useThemedStyles(createStyles);
  const { t } = useI18n();
  const [account, setAccount] = useState<ClaudeCodeAccount | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [oauth, setOauth] = useState<ModelOAuthBegin | null>(null);
  const [pasteCode, setPasteCode] = useState("");
  const [pending, setPending] = useState<"sign-in" | "code" | "key" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useFocusEffect(
    useCallback(() => {
      void rpc<ClaudeCodeAccount>("claudeCode/account")
        .then(setAccount)
        .catch((err: unknown) => setError(errorText(err, t("Could not load Claude Code"))));
    }, [t]),
  );

  useEffect(() => () => cancelModelOAuthAttempt(abortRef, () => undefined), []);

  async function run(
    kind: "key" | "disconnect",
    work: () => Promise<ClaudeCodeAccount>,
  ): Promise<boolean> {
    setPending(kind);
    setError(null);
    try {
      setAccount(await work());
      return true;
    } catch (err) {
      setError(errorText(err, t("Could not save")));
      return false;
    } finally {
      setPending(null);
    }
  }

  async function signIn() {
    setPending("sign-in");
    setError(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const started = await rpc<ModelOAuthBegin>(
        "models/beginOAuth",
        { provider: "anthropic", label: "Claude Code" },
        { signal: controller.signal },
      );
      setPasteCode("");
      setOauth(started);
      await Linking.openURL(started.verificationUri);
    } catch (err) {
      if (!controller.signal.aborted) setError(errorText(err, t("Could not start sign-in")));
      setOauth(null);
    } finally {
      setPending(null);
    }
  }

  async function submitCode() {
    const controller = abortRef.current;
    const code = pasteCode.trim();
    if (!oauth || !controller || !code) return;
    setPending("code");
    setError(null);
    try {
      await rpc(
        "models/submitOAuthCode",
        { loginId: oauth.loginId, code },
        { signal: controller.signal },
      );
      await waitForModelOAuth(oauth.loginId, controller.signal);
      setAccount(
        await rpc<ClaudeCodeAccount>(
          "claudeCode/finishSignIn",
          { loginId: oauth.loginId },
          { signal: controller.signal },
        ),
      );
      setOauth(null);
      setPasteCode("");
    } catch (err) {
      if (!controller.signal.aborted) setError(errorText(err, t("Could not finish sign-in")));
    } finally {
      setPending(null);
    }
  }

  function cancelSignIn() {
    const loginId = oauth?.loginId;
    cancelModelOAuthAttempt(abortRef, () => setOauth(null));
    if (loginId) void rpc("models/cancelOAuth", { loginId }).catch(() => undefined);
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} contentInsetAdjustmentBehavior="automatic">
        {!account && !error ? <ActivityIndicator color={native.secondaryLabel} /> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {account?.connected ? (
          <Text style={styles.status}>
            {account.kind === "api_key"
              ? t("Using an Anthropic API key")
              : t("Signed in with Claude")}
          </Text>
        ) : null}
        {oauth ? (
          <>
            <Text style={styles.secondary}>{t("Finish signing in in your browser:")}</Text>
            <Pressable onPress={() => void Linking.openURL(oauth.verificationUri)}>
              <Text style={styles.link} numberOfLines={2}>
                {oauth.verificationUri}
              </Text>
            </Pressable>
            <Text style={styles.secondary}>
              {t("The final page may not load. Paste its URL or code here.")}
            </Text>
            <TextInput
              accessibilityLabel={t("Authorization code")}
              value={pasteCode}
              onChangeText={setPasteCode}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t("http://localhost:53692/callback?code=…")}
              placeholderTextColor={native.tertiaryLabel}
              style={styles.input}
            />
            <NativeActionButton
              disabled={!pasteCode.trim() || pending !== null}
              label={t("Submit")}
              onPress={() => void submitCode()}
            />
            <NativeActionButton label={t("Cancel")} onPress={cancelSignIn} prominence="secondary" />
          </>
        ) : (
          <NativeActionButton
            disabled={pending !== null || !account}
            label={
              pending === "sign-in"
                ? t("Starting…")
                : account?.connected
                  ? t("Sign in again")
                  : t("Sign in with Claude")
            }
            onPress={() => void signIn()}
          />
        )}
        <Text style={[styles.fieldLabel, { marginTop: 16 }]}>
          {t("Or use an Anthropic API key")}
        </Text>
        <TextInput
          accessibilityLabel={t("Or use an Anthropic API key")}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          importantForAutofill="no"
          editable={account !== null}
          value={apiKey}
          onChangeText={setApiKey}
          placeholder={t("Paste your API key")}
          placeholderTextColor={native.tertiaryLabel}
          secureTextEntry
          style={styles.input}
          textContentType="none"
        />
        <NativeActionButton
          disabled={pending !== null || apiKey.trim().length < 8}
          label={pending === "key" ? t("Connecting…") : t("Connect")}
          onPress={() =>
            void run("key", () =>
              rpc<ClaudeCodeAccount>("claudeCode/connectKey", { apiKey: apiKey.trim() }),
            ).then((saved) => {
              if (saved) setApiKey("");
            })
          }
          prominence="secondary"
        />
        {account?.connected ? (
          <NativeActionButton
            disabled={pending !== null}
            label={pending === "disconnect" ? t("Disconnecting…") : t("Disconnect")}
            onPress={() =>
              void run("disconnect", () => rpc<ClaudeCodeAccount>("claudeCode/disconnect"))
            }
            prominence="destructive"
          />
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
    status: { color: native.label, fontSize: 15 },
    secondary: { color: native.secondaryLabel, fontSize: 14 },
    link: { color: tokens.link, fontSize: 14 },
    fieldLabel: { color: native.label },
    input: {
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
  });
}

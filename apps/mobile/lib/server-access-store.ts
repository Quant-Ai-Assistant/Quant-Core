import * as SecureStore from "expo-secure-store";
import type { ServerAccess } from "./server-access";
import { setActiveServerAccess } from "./server-access";

const ACCESS_KEY = "quant.server_access";

export async function loadServerAccess(): Promise<void> {
  try {
    const stored = await SecureStore.getItemAsync(ACCESS_KEY);
    const parsed = stored
      ? (JSON.parse(stored) as { apiBase?: string; access?: Partial<ServerAccess> })
      : null;
    const access = parsed?.access;
    setActiveServerAccess(
      parsed?.apiBase ?? null,
      typeof access?.username === "string" && typeof access.password === "string"
        ? { username: access.username, password: access.password }
        : null,
    );
  } catch {
    setActiveServerAccess(null, null);
  }
}

/** Saves the gate credentials for `apiBase`, or forgets them when `access` is null. */
export async function saveServerAccess(apiBase: string, access: ServerAccess | null) {
  if (access) {
    await SecureStore.setItemAsync(ACCESS_KEY, JSON.stringify({ apiBase, access }));
  } else {
    await SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => undefined);
  }
  setActiveServerAccess(apiBase, access);
}

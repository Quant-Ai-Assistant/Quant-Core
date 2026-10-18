import type { MobileBot } from "./api";

export function retainUnchangedBotRoster(current: MobileBot[], next: MobileBot[]): MobileBot[] {
  // The RPC returns full Bot records, including arrays omitted from MobileBot.
  // Compare every field by value while preserving roster and array order.
  const unchanged =
    current.length === next.length &&
    current.every((bot, index) => {
      const candidate = next[index]!;
      const keys = Object.keys(bot) as Array<keyof MobileBot>;
      return (
        keys.length === Object.keys(candidate).length &&
        keys.every((key) => {
          if (!Object.hasOwn(candidate, key)) return false;
          const value = bot[key];
          const nextValue = candidate[key];
          if (Array.isArray(value) && Array.isArray(nextValue)) {
            return (
              value.length === nextValue.length &&
              value.every((item, index) => item === nextValue[index])
            );
          }
          return value === nextValue || sameFlatRecord(value, nextValue);
        })
      );
    });
  return unchanged ? current : next;
}

/** Settings objects such as `claudeCode` hold only scalars, so one level of comparison is enough. */
function sameFlatRecord(value: unknown, nextValue: unknown): boolean {
  if (!value || !nextValue || typeof value !== "object" || typeof nextValue !== "object") {
    return false;
  }
  if (Array.isArray(value) || Array.isArray(nextValue)) return false;
  const left = value as Record<string, unknown>;
  const right = nextValue as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
  );
}

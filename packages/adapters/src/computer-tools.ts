import type {
  AgentToolExecutionResult,
  ComputerAction,
  ComputerElement,
  ComputerElementAction,
  ComputerObservation,
} from "@rakazo/adapter-kit";
import { UNSUPPORTED_ELEMENT_ACTION } from "./computer-support.js";

/** Identical visual actions that leave the frame unchanged before computer_act stops repeating them. */
export const MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS = 3;

const VISUAL_COMPUTER_ACTIONS = new Set<ComputerAction["kind"]>(["scroll", "pointer", "key"]);

const PREVIOUS_SCREENSHOT_VALID =
  "The previous screenshot remains valid; this identical frame was omitted.";

export type UnchangedVisualStreak = {
  frameId?: string;
  actionKey?: string;
  count: number;
};

export type ObservationToolOptions = {
  /** Consecutive identical visual actions that left this frame unchanged. */
  unchangedVisualCount?: number;
};

const ELEMENT_ONLY_KINDS = new Set(["press", "fill", "hover"]);

/** Elements listed in a tool result. More would crowd the context without helping a click. */
const MAX_LISTED_ELEMENTS = 200;

export function parseComputerActions(
  value: unknown,
  options: { elements?: boolean } = {},
): ComputerAction[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("computer_act requires at least one action");
  }
  if (value.length > 24) throw new Error("computer_act accepts at most 24 actions");
  const actions = value.flatMap((raw): ComputerAction[] => {
    if (!raw || typeof raw !== "object") throw new Error("computer action must be an object");
    const action = raw as Record<string, unknown>;
    const kind = String(action.kind ?? "");
    const usesElements =
      kind === "menu" ||
      ELEMENT_ONLY_KINDS.has(kind) ||
      (kind === "click" && action.element !== undefined);
    if (usesElements && !options.elements) {
      throw new Error(UNSUPPORTED_ELEMENT_ACTION);
    }
    if (kind === "click" && action.element !== undefined) {
      const elementAction: ComputerElementAction =
        action.button === "right"
          ? "right_click"
          : action.double === true
            ? "double_click"
            : "click";
      return [{ kind: "element", element: elementId(action.element), action: elementAction }];
    }
    if (ELEMENT_ONLY_KINDS.has(kind)) {
      return [
        {
          kind: "element",
          element: elementId(action.element),
          action: kind as ComputerElementAction,
          ...(kind === "fill" ? { text: String(action.text ?? "") } : {}),
        },
      ];
    }
    if (kind === "menu") {
      const path = Array.isArray(action.path)
        ? action.path.map((title) => String(title).trim())
        : [];
      if (path.length === 0 || path.some((title) => !title)) {
        throw new Error("computer action menu requires a path of menu titles");
      }
      const application = String(action.application ?? "").trim();
      return [{ kind: "menu", path, ...(application ? { application } : {}) }];
    }
    if (kind === "click" || kind === "move" || kind === "down" || kind === "up") {
      const x = finiteCoordinate(action.x, "x");
      const y = finiteCoordinate(action.y, "y");
      const pointer: ComputerAction = {
        kind: "pointer",
        x,
        y,
        type: kind,
        button: action.button === "right" ? "right" : "left",
      };
      return action.double === true && kind === "click" ? [pointer, pointer] : [pointer];
    }
    if (kind === "type") {
      return [{ kind: "clipboard", text: String(action.text ?? "") }];
    }
    if (kind === "key") {
      return [
        {
          kind: "key",
          key: String(action.key ?? ""),
          modifiers: Array.isArray(action.modifiers) ? action.modifiers.map(String) : undefined,
        },
      ];
    }
    if (kind === "scroll") {
      return [
        {
          kind: "scroll",
          direction: action.direction === "up" ? "up" : "down",
          amount: boundedNumber(action.amount, 1, 20, 3),
        },
      ];
    }
    if (kind === "wait") {
      return [{ kind: "wait", ms: boundedNumber(action.ms, 0, 5_000, 350) }];
    }
    if (kind === "focus") {
      const application = String(action.application ?? "").trim();
      if (!application) throw new Error("computer action focus requires an application");
      return [
        {
          kind: "focus",
          application,
          ...(action.uri === undefined ? {} : { uri: String(action.uri) }),
        },
      ];
    }
    throw new Error(`unsupported computer action ${kind || "(missing)"}`);
  });
  if (actions.length > 24) {
    throw new Error("computer_act expands to more than 24 actions; split the batch");
  }
  return actions;
}

export function observationToolResult(
  observation: ComputerObservation,
  note = "computer observed",
  previousFrameId?: string,
  options?: ObservationToolOptions,
): AgentToolExecutionResult {
  const unchanged = previousFrameId === observation.frameId;
  const unchangedVisualCount = options?.unchangedVisualCount ?? 0;
  const visualLoop = unchanged && unchangedVisualCount >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS;
  const details = {
    frameId: observation.frameId,
    capturedAt: observation.capturedAt,
    width: observation.width,
    height: observation.height,
    cursor: observation.cursor,
    activeWindow: observation.activeWindow,
    ...(unchanged ? unchangedScreenDetails(observation.frameId, unchangedVisualCount) : {}),
  };
  const status = unchanged
    ? visualLoop
      ? ` (screen unchanged). ${PREVIOUS_SCREENSHOT_VALID} ${visualLoopGuidance(unchangedVisualCount)}`
      : ` (screen unchanged). ${PREVIOUS_SCREENSHOT_VALID}`
    : "";
  const elementLines =
    !unchanged && observation.elements?.length ? computerElementLines(observation.elements) : [];
  const elementsText = elementLines.length
    ? `\nUI elements (use ids with computer_act):\n${elementLines.join("\n")}`
    : "";
  return {
    kind: "agent_tool_result",
    content: [
      {
        type: "text",
        text: `${note}${status}\n${JSON.stringify(details)}${elementsText}`,
      },
      ...(unchanged
        ? []
        : [
            {
              type: "image" as const,
              data: Buffer.from(observation.image).toString("base64"),
              mimeType: observation.mimeType,
            },
          ]),
    ],
    details,
  };
}

/** Stable identity for scroll, pointer, and key actions. Typing and waiting are not visual loops. */
export function computerVisualActionKey(actions: readonly ComputerAction[]): string | undefined {
  const visual = actions.filter((action) => VISUAL_COMPUTER_ACTIONS.has(action.kind));
  if (visual.length === 0) return undefined;
  return JSON.stringify(visual);
}

/** Typing and other non-wait actions still need to run. A wait does not. */
function batchEscapesVisualGuard(actions: readonly ComputerAction[]): boolean {
  return actions.some(
    (action) => action.kind !== "wait" && !VISUAL_COMPUTER_ACTIONS.has(action.kind),
  );
}

/**
 * Counts identical visual actions that keep the same frame. A new frame clears the streak.
 * Observations without a visual action leave an in-progress streak in place.
 */
export function advanceUnchangedVisualGuard(
  streak: UnchangedVisualStreak,
  frameId: string,
  actionKey?: string,
): { streak: UnchangedVisualStreak; engaged: boolean } {
  if (streak.frameId !== frameId) {
    return { streak: { frameId, count: 0 }, engaged: false };
  }
  if (!actionKey) return { streak, engaged: false };
  const count = streak.actionKey === actionKey ? streak.count + 1 : 1;
  const next = { frameId, actionKey, count };
  return {
    streak: next,
    engaged: count >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS,
  };
}

/** Refuse a matching visual batch. Waits do not exempt it; typing does. */
export function unchangedVisualActionBlocked(
  streak: UnchangedVisualStreak,
  actions: readonly ComputerAction[],
): boolean {
  if (batchEscapesVisualGuard(actions)) return false;
  const actionKey = computerVisualActionKey(actions);
  return (
    actionKey !== undefined &&
    actionKey === streak.actionKey &&
    streak.count >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS
  );
}

const MUTATING_PAGE_BROWSER_TOOLS = new Set(["browser_navigate", "browser_act"]);

function pageBrowserMutationSucceeded(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const record = result as { error?: unknown; fallback?: unknown; ok?: unknown };
  if (record.fallback === "computer_act") return false;
  if (typeof record.error === "string" && record.error.length > 0) return false;
  if (record.ok === false) return false;
  return true;
}

/** A successful page mutation can change the live view without a new desktop frame. */
export function unchangedVisualStreakAfterPageBrowser(
  streak: UnchangedVisualStreak,
  toolName: string,
  result: unknown,
): UnchangedVisualStreak {
  if (!MUTATING_PAGE_BROWSER_TOOLS.has(toolName) || !pageBrowserMutationSucceeded(result)) {
    return streak;
  }
  return { count: 0 };
}

export function unchangedVisualLoopToolResult(
  streak: UnchangedVisualStreak,
): AgentToolExecutionResult {
  const details = unchangedScreenDetails(streak.frameId, streak.count);
  const text = `The same visual action left the screen unchanged ${streak.count} times and was not run again. The previous screenshot remains valid. Use browser_snapshot or a different action.`;
  return {
    kind: "agent_tool_result",
    content: [{ type: "text", text: `${text}\n${JSON.stringify(details)}` }],
    details,
  };
}

function unchangedScreenDetails(frameId: string | undefined, unchangedVisualCount: number) {
  return {
    frameId,
    screenUnchanged: true,
    screenshotOmitted: true,
    previousScreenshotValid: true,
    ...(unchangedVisualCount > 0 ? { unchangedVisualCount } : {}),
    ...(unchangedVisualCount >= MAX_CONSECUTIVE_UNCHANGED_VISUAL_ACTIONS
      ? { unchangedVisualLoop: true }
      : {}),
  };
}

function visualLoopGuidance(count: number) {
  return `The same visual action has left the screen unchanged ${count} times. Stop repeating it and use browser_snapshot or a different action.`;
}

function elementId(value: unknown) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1) {
    throw new Error("computer action element must be an element id from computer_observe");
  }
  return id;
}

/** One line per control, e.g. `12 button "Save" at 640,410 120x28`. */
export function computerElementLines(elements: readonly ComputerElement[]): string[] {
  return elements.slice(0, MAX_LISTED_ELEMENTS).map((element) => {
    const parts = [String(element.id), element.role];
    if (element.label) parts.push(JSON.stringify(element.label));
    if (element.value !== undefined) parts.push(`value=${JSON.stringify(element.value)}`);
    if (element.secure) parts.push("secure");
    if (element.disabled) parts.push("disabled");
    if (element.focused) parts.push("focused");
    parts.push(`at ${element.x},${element.y} ${element.width}x${element.height}`);
    return parts.join(" ");
  });
}

function finiteCoordinate(value: unknown, name: string) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number < 0 || number > 100_000) {
    throw new Error(`computer action ${name} must be a non-negative coordinate`);
  }
  return number;
}

function boundedNumber(value: unknown, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

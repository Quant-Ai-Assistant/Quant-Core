/**
 * JavaScript for Automation run by `osascript` on the host Mac. It captures the main display,
 * reads interactive elements of the frontmost application through the Accessibility API,
 * and posts mouse and keyboard events. It ships inline so bundled builds need no extra file.
 * It is a string, never imported, so it must not contain a backtick or a template placeholder.
 */
export const MAC_SCREEN_DRIVER = String.raw`
ObjC.import("AppKit");
ObjC.import("ApplicationServices");
ObjC.import("CoreGraphics");

const ATTRS = [
  "AXRole",
  "AXSubrole",
  "AXTitle",
  "AXDescription",
  "AXValue",
  "AXPlaceholderValue",
  "AXPosition",
  "AXSize",
  "AXEnabled",
  "AXFocused",
  "AXChildren",
];
const INTERACTIVE = new Set([
  "AXButton",
  "AXCheckBox",
  "AXRadioButton",
  "AXTextField",
  "AXTextArea",
  "AXSecureTextField",
  "AXSearchField",
  "AXComboBox",
  "AXPopUpButton",
  "AXMenuButton",
  "AXLink",
  "AXSlider",
  "AXIncrementor",
  "AXDisclosureTriangle",
  "AXTab",
  "AXMenuItem",
  "AXRow",
  "AXCell",
  "AXDockItem",
]);
const TEXT_ROLES = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]);
const VALUE_ROLES = new Set([...TEXT_ROLES, "AXCheckBox", "AXRadioButton", "AXSlider", "AXPopUpButton"]);
const WINDOW_BUTTONS = {
  AXCloseButton: "close window",
  AXMinimizeButton: "minimize window",
  AXZoomButton: "zoom window",
  AXFullScreenButton: "full screen",
};
const MAX_VISITED = 4000;
const MAX_ELEMENTS = 250;
const BUDGET_MS = 2500;

ObjC.bindFunction("CGPreflightScreenCaptureAccess", ["bool", []]);
ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]);

function run(argv) {
  try {
    const request = JSON.parse(argv[0]);
    if (request.op === "observe") return JSON.stringify(observe(request));
    if (request.op === "act") return JSON.stringify(act(request));
    throw new Error("unknown op " + request.op);
  } catch (error) {
    return JSON.stringify({ error: String(error && error.message ? error.message : error) });
  }
}

function requireAccessibility() {
  if ($.AXIsProcessTrusted()) return;
  $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
  throw new Error("permission:accessibility");
}

function requireScreen() {
  if ($.CGPreflightScreenCaptureAccess()) return;
  $.CGRequestScreenCaptureAccess();
  throw new Error("permission:screen");
}

function mainScreen() {
  const frame = $.NSScreen.screens.objectAtIndex(0).frame;
  return { width: frame.size.width, height: frame.size.height };
}

function cf(value) {
  if (value === undefined || value === null) return undefined;
  const type = $.CFGetTypeID(value);
  if (type === $.AXValueGetTypeID()) {
    const text = ObjC.unwrap(value.description);
    if (text.includes("kAXValueAXErrorType")) return undefined;
    const number = (key) => {
      const match = text.match(new RegExp(key + ":(-?[0-9.]+)"));
      return match ? Number(match[1]) : undefined;
    };
    if (text.includes("kAXValueCGPointType")) return { x: number("x"), y: number("y") };
    if (text.includes("kAXValueCGSizeType")) return { w: number("w"), h: number("h") };
    return undefined;
  }
  if (type === $.CFArrayGetTypeID()) return value;
  if (type === $.AXUIElementGetTypeID()) return value;
  const unwrapped = ObjC.unwrap(value);
  return typeof unwrapped === "object" ? undefined : unwrapped;
}

function attribute(element, name) {
  const ref = Ref();
  if ($.AXUIElementCopyAttributeValue(element, $(name), ref) !== 0) return undefined;
  return cf(ObjC.castRefToObject(ref[0]));
}

function attributes(element) {
  const ref = Ref();
  if ($.AXUIElementCopyMultipleAttributeValues(element, $(ATTRS), 0, ref) !== 0) return undefined;
  const values = ObjC.castRefToObject(ref[0]);
  const result = {};
  for (let index = 0; index < ATTRS.length; index++) {
    result[ATTRS[index]] = cf(values.objectAtIndex(index));
  }
  return result;
}

function arrayItems(array) {
  if (!array) return [];
  const items = [];
  const count = Number(array.count);
  for (let index = 0; index < count; index++) items.push(array.objectAtIndex(index));
  return items;
}

function text(value, limit) {
  if (value === undefined || value === null) return undefined;
  const string = String(value).replace(/\s+/g, " ").trim();
  if (!string) return undefined;
  return string.length > limit ? string.slice(0, limit - 1) + "…" : string;
}

function frontApplication(name) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  if (!name) return workspace.frontmostApplication;
  const wanted = name.toLowerCase();
  const apps = arrayItems(workspace.runningApplications);
  return apps.find((app) => {
    const localized = ObjC.unwrap(app.localizedName);
    const bundle = ObjC.unwrap(app.bundleIdentifier);
    return (
      (localized && localized.toLowerCase() === wanted) ||
      (bundle && bundle.toLowerCase() === wanted)
    );
  });
}

function applicationElement(pid) {
  const app = $.AXUIElementCreateApplication(pid);
  $.AXUIElementSetMessagingTimeout(app, 0.6);
  // Chromium and Electron build their accessibility tree only when an assistive client asks.
  $.AXUIElementSetAttributeValue(app, $("AXManualAccessibility"), $(true));
  return app;
}

function windowsOf(app) {
  const windows = arrayItems(attribute(app, "AXWindows"));
  const focused = attribute(app, "AXFocusedWindow");
  if (!focused) return windows.map((window, index) => ({ window, index }));
  const ordered = windows.map((window, index) => ({ window, index }));
  ordered.sort((a, b) => Number($.CFEqual(b.window, focused)) - Number($.CFEqual(a.window, focused)));
  return ordered;
}

function label(attrs, element, role) {
  const own =
    text(attrs.AXTitle, 80) ||
    text(attrs.AXDescription, 80) ||
    text(attrs.AXPlaceholderValue, 80);
  if (own) return own;
  const subrole = WINDOW_BUTTONS[attrs.AXSubrole];
  if (subrole) return subrole;
  if (role === "AXRow" || role === "AXCell" || role === "AXLink" || role === "AXButton") {
    return descendantText(element, 3);
  }
  return undefined;
}

function descendantText(element, depth) {
  if (depth === 0) return undefined;
  for (const child of arrayItems(attribute(element, "AXChildren")).slice(0, 8)) {
    const role = attribute(child, "AXRole");
    if (role === "AXStaticText") {
      const value = text(attribute(child, "AXValue"), 80);
      if (value) return value;
    }
    const nested = descendantText(child, depth - 1);
    if (nested) return nested;
  }
  return undefined;
}

function visibleRect(position, size, screen) {
  if (!position || !size || !(size.w > 1) || !(size.h > 1)) return undefined;
  const left = Math.max(position.x, 0);
  const top = Math.max(position.y, 0);
  const right = Math.min(position.x + size.w, screen.width);
  const bottom = Math.min(position.y + size.h, screen.height);
  if (right - left < 2 || bottom - top < 2) return undefined;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function collectElements(app, screen) {
  const started = Date.now();
  const elements = [];
  const queue = windowsOf(app).map(({ window, index }) => ({ element: window, path: [index] }));
  let visited = 0;
  while (queue.length && visited < MAX_VISITED && elements.length < MAX_ELEMENTS) {
    if (Date.now() - started > BUDGET_MS) break;
    const { element, path } = queue.shift();
    visited++;
    const attrs = attributes(element);
    if (!attrs) continue;
    const role = attrs.AXRole;
    const rect = visibleRect(attrs.AXPosition, attrs.AXSize, screen);
    if (role && INTERACTIVE.has(role) && rect) {
      const secure = role === "AXSecureTextField";
      elements.push({
        role,
        ...(attrs.AXSubrole ? { subrole: attrs.AXSubrole } : {}),
        label: label(attrs, element, role),
        ...(VALUE_ROLES.has(role) && !secure && attrs.AXValue !== undefined
          ? { value: text(attrs.AXValue, 60) }
          : {}),
        ...(secure ? { secure: true } : {}),
        ...(attrs.AXEnabled === false ? { disabled: true } : {}),
        ...(attrs.AXFocused === true ? { focused: true } : {}),
        rect,
        path,
      });
    }
    // Offscreen subtrees of scroll views can be huge; only descend into containers that
    // reach the screen or have no frame of their own.
    if (attrs.AXPosition && attrs.AXSize && !rect && role !== "AXWindow") continue;
    arrayItems(attrs.AXChildren).forEach((child, index) => {
      queue.push({ element: child, path: [...path, index] });
    });
  }
  return elements;
}

function capture(path) {
  const task = $.NSTask.alloc.init;
  task.launchPath = "/usr/sbin/screencapture";
  task.arguments = $(["-x", "-m", "-t", "png", path]);
  task.launch;
  task.waitUntilExit;
  if (task.terminationStatus !== 0) throw new Error("screencapture failed");
}

function observe(request) {
  requireScreen();
  requireAccessibility();
  const screen = mainScreen();
  capture(request.capturePath);
  const source = $.NSImage.alloc.initWithContentsOfFile($(request.capturePath));
  if (!source || source.isNil()) throw new Error("screencapture produced no image");
  const scale = imageScale(screen, request.maxEdge);
  const width = Math.round(screen.width * scale);
  const height = Math.round(screen.height * scale);

  const front = frontApplication(request.application);
  if (!front) throw new Error("application " + request.application + " is not running");
  const pid = Number(front.processIdentifier);
  const app = applicationElement(pid);
  const elements = collectElements(app, screen).map((element, index) => ({
    id: index + 1,
    ...element,
    rect: {
      x: Math.round(element.rect.x * scale),
      y: Math.round(element.rect.y * scale),
      w: Math.round(element.rect.w * scale),
      h: Math.round(element.rect.h * scale),
    },
  }));
  const focusedWindow = attribute(app, "AXFocusedWindow");

  const rep = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null,
    width,
    height,
    8,
    4,
    true,
    false,
    $.NSDeviceRGBColorSpace,
    0,
    0,
  );
  const context = $.NSGraphicsContext.graphicsContextWithBitmapImageRep(rep);
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext(context);
  context.setImageInterpolation($.NSImageInterpolationHigh);
  source.drawInRectFromRectOperationFraction(
    $.NSMakeRect(0, 0, width, height),
    $.NSZeroRect,
    $.NSCompositingOperationCopy,
    1,
  );
  if (request.marks) drawMarks(elements, height);
  $.NSGraphicsContext.restoreGraphicsState;
  const data = rep.representationUsingTypeProperties(
    $.NSBitmapImageFileTypeJPEG,
    $({ NSImageCompressionFactor: 0.85 }),
  );
  data.writeToFileAtomically($(request.outputPath), true);

  const mouse = $.NSEvent.mouseLocation;
  return {
    width,
    height,
    scale,
    cursor: {
      x: Math.round(mouse.x * scale),
      y: Math.round((screen.height - mouse.y) * scale),
    },
    application: {
      pid,
      name: ObjC.unwrap(front.localizedName),
      bundleId: ObjC.unwrap(front.bundleIdentifier),
    },
    windowTitle: focusedWindow ? text(attribute(focusedWindow, "AXTitle"), 120) : undefined,
    elements,
  };
}

function drawMarks(elements, height) {
  const stroke = $.NSColor.colorWithSRGBRedGreenBlueAlpha(1, 0.18, 0.33, 0.9);
  const font = $.NSFont.monospacedDigitSystemFontOfSizeWeight(10, $.NSFontWeightBold);
  const attrs = $.NSDictionary.dictionaryWithObjectsForKeys(
    $([font, $.NSColor.whiteColor, stroke]),
    $([$.NSFontAttributeName, $.NSForegroundColorAttributeName, $.NSBackgroundColorAttributeName]),
  );
  for (const element of elements) {
    const { x, y, w, h } = element.rect;
    const path = $.NSBezierPath.bezierPathWithRect($.NSMakeRect(x + 0.5, height - y - h + 0.5, w - 1, h - 1));
    path.lineWidth = 1;
    stroke.setStroke;
    path.stroke;
    $(String(element.id)).drawAtPointWithAttributes($.NSMakePoint(x + 1, height - y - 12), attrs);
  }
}

// ---- actions ----

const MODIFIER_FLAGS = {
  cmd: 1 << 20,
  command: 1 << 20,
  meta: 1 << 20,
  super: 1 << 20,
  win: 1 << 20,
  shift: 1 << 17,
  ctrl: 1 << 18,
  control: 1 << 18,
  alt: 1 << 19,
  option: 1 << 19,
  opt: 1 << 19,
  fn: 1 << 23,
};

const KEY_CODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14,
  r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24,
  "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, o: 31, u: 32, "[": 33, i: 34,
  p: 35, l: 37, j: 38, "'": 39, k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46,
  ".": 47, "\u0060": 50,
  return: 36, enter: 36, kp_enter: 76, tab: 48, space: 49, " ": 49, backspace: 51,
  delete: 117, forwarddelete: 117, escape: 53, esc: 53,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, page_up: 116, prior: 116, pagedown: 121,
  page_down: 121, next: 121,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109,
  f11: 103, f12: 111,
};

function keyCode(name) {
  const normalized = name.toLowerCase().replace(/^arrow/, "").replace(/^(key_)/, "");
  if (normalized === "backspace" || normalized === "back_space") return KEY_CODES.backspace;
  const code = KEY_CODES[normalized];
  if (code === undefined) throw new Error("unsupported key " + name);
  return code;
}

function post(event) {
  $.CGEventPost($.kCGHIDEventTap, event);
}

function pressKey(key, modifiers) {
  const parts = String(key).split("+").filter(Boolean);
  const main = parts.length > 1 ? parts.pop() : String(key);
  let flags = 0;
  for (const modifier of [...parts, ...(modifiers || [])]) {
    const flag = MODIFIER_FLAGS[String(modifier).toLowerCase()];
    if (flag === undefined) throw new Error("unsupported modifier " + modifier);
    flags |= flag;
  }
  const code = keyCode(main);
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent(null, code, down);
    $.CGEventSetFlags(event, flags);
    post(event);
  }
}

const mouse = { held: undefined, lastClick: undefined };

function mouseEvent(type, point, button) {
  const event = $.CGEventCreateMouseEvent(null, type, point, button);
  return event;
}

function pointer(action, scale) {
  const point = $.CGPointMake(action.x / scale, action.y / scale);
  const right = action.button === "right";
  const button = right ? $.kCGMouseButtonRight : $.kCGMouseButtonLeft;
  const downType = right ? $.kCGEventRightMouseDown : $.kCGEventLeftMouseDown;
  const upType = right ? $.kCGEventRightMouseUp : $.kCGEventLeftMouseUp;
  if (action.type === "move") {
    const type = mouse.held
      ? mouse.held === "right"
        ? $.kCGEventRightMouseDragged
        : $.kCGEventLeftMouseDragged
      : $.kCGEventMouseMoved;
    post(mouseEvent(type, point, button));
    return;
  }
  if (action.type === "down") {
    mouse.held = right ? "right" : "left";
    post(mouseEvent(downType, point, button));
    return;
  }
  if (action.type === "up") {
    mouse.held = undefined;
    post(mouseEvent(upType, point, button));
    return;
  }
  const now = Date.now();
  const last = mouse.lastClick;
  const count =
    last && now - last.at < 500 && Math.abs(last.x - action.x) < 4 && Math.abs(last.y - action.y) < 4 && last.right === right
      ? last.count + 1
      : 1;
  mouse.lastClick = { at: now, x: action.x, y: action.y, right, count };
  post(mouseEvent($.kCGEventMouseMoved, point, button));
  for (const type of [downType, upType]) {
    const event = mouseEvent(type, point, button);
    $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, count);
    post(event);
  }
}

function scroll(action) {
  const lines = Math.max(1, action.amount || 3) * 3;
  const event = $.CGEventCreateScrollWheelEvent2(
    null,
    $.kCGScrollEventUnitLine,
    1,
    action.direction === "up" ? lines : -lines,
    0,
    0,
  );
  post(event);
}

function savePasteboard(pasteboard) {
  return arrayItems(pasteboard.pasteboardItems).map((item) =>
    arrayItems(item.types).map((type) => ({ type, data: item.dataForType(type) })),
  );
}

function restorePasteboard(pasteboard, saved) {
  pasteboard.clearContents;
  if (!saved.length) return;
  const items = saved.map((entries) => {
    const item = $.NSPasteboardItem.alloc.init;
    for (const { type, data } of entries) if (data && !data.isNil()) item.setDataForType(data, type);
    return item;
  });
  pasteboard.writeObjects($(items));
}

function typeText(value) {
  const pasteboard = $.NSPasteboard.generalPasteboard;
  const saved = savePasteboard(pasteboard);
  pasteboard.clearContents;
  pasteboard.setStringForType($(value), $.NSPasteboardTypeString);
  pressKey("v", ["cmd"]);
  delay(0.35);
  restorePasteboard(pasteboard, saved);
}

function openWith(args) {
  const task = $.NSTask.alloc.init;
  task.launchPath = "/usr/bin/open";
  task.arguments = $(args);
  task.launch;
  task.waitUntilExit;
  if (task.terminationStatus !== 0) throw new Error("could not open " + args.join(" "));
}

function resolveElement(target) {
  const app = applicationElement(target.pid);
  const windows = arrayItems(attribute(app, "AXWindows"));
  let element = windows[target.path[0]];
  for (const index of target.path.slice(1)) {
    if (!element) break;
    element = arrayItems(attribute(element, "AXChildren"))[index];
  }
  if (element && matches(element, target)) return element;
  throw new Error("element " + target.id + " changed; observe again");
}

function matches(element, target) {
  const attrs = attributes(element);
  if (!attrs || attrs.AXRole !== target.role) return false;
  if (!target.label) return true;
  return label(attrs, element, attrs.AXRole) === target.label;
}

function elementCenter(element, screen) {
  let rect = visibleRect(attribute(element, "AXPosition"), attribute(element, "AXSize"), screen);
  if (!rect) {
    $.AXUIElementPerformAction(element, $("AXScrollToVisible"));
    delay(0.15);
    rect = visibleRect(attribute(element, "AXPosition"), attribute(element, "AXSize"), screen);
  }
  return rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : undefined;
}

function elementAction(action, target, scale) {
  const element = resolveElement(target);
  const screen = mainScreen();
  if (action.action === "press") {
    if ($.AXUIElementPerformAction(element, $("AXPress")) === 0) return;
  }
  if (action.action === "focus") {
    if ($.AXUIElementSetAttributeValue(element, $("AXFocused"), $(true)) === 0) return;
  }
  const center = elementCenter(element, screen);
  if (!center) {
    if ($.AXUIElementPerformAction(element, $("AXPress")) === 0) return;
    throw new Error("element " + target.id + " is not visible");
  }
  const at = { x: center.x * scale, y: center.y * scale };
  if (action.action === "hover") {
    pointer({ ...at, type: "move" }, scale);
    return;
  }
  const button = action.action === "right_click" ? "right" : "left";
  pointer({ ...at, type: "click", button }, scale);
  if (action.action === "double_click") pointer({ ...at, type: "click", button }, scale);
  if (action.action === "fill") {
    delay(0.1);
    pressKey("a", ["cmd"]);
    if (action.text) typeText(action.text);
    else pressKey("backspace");
  }
}

function pressMenu(action) {
  const front = frontApplication(action.application);
  if (!front) throw new Error("application " + action.application + " is not running");
  const app = applicationElement(Number(front.processIdentifier));
  let items = arrayItems(attribute(attribute(app, "AXMenuBar"), "AXChildren"));
  let item;
  action.path.forEach((title, depth) => {
    item = items.find((candidate) => menuTitleMatches(attribute(candidate, "AXTitle"), title));
    if (!item) throw new Error("menu item " + action.path.slice(0, depth + 1).join(" > ") + " not found");
    const menu = arrayItems(attribute(item, "AXChildren"))[0];
    items = menu ? arrayItems(attribute(menu, "AXChildren")) : [];
  });
  if (attribute(item, "AXEnabled") === false) {
    throw new Error("menu item " + action.path.join(" > ") + " is disabled");
  }
  if ($.AXUIElementPerformAction(item, $("AXPress")) !== 0) {
    throw new Error("could not press menu item " + action.path.join(" > "));
  }
}

function menuTitleMatches(title, wanted) {
  const normalize = (value) =>
    String(value || "")
      .replace(/(…|\.\.\.)$/u, "")
      .trim()
      .toLowerCase();
  return normalize(title) === normalize(wanted);
}

function imageScale(screen, maxEdge) {
  return Math.min(1, maxEdge / Math.max(screen.width, screen.height));
}

function act(request) {
  requireAccessibility();
  const scale = imageScale(mainScreen(), request.maxEdge);
  let completed = 0;
  try {
    for (const action of request.actions) {
      if (action.kind === "pointer") pointer(action, scale);
      else if (action.kind === "key") pressKey(action.key, action.modifiers);
      else if (action.kind === "clipboard") typeText(action.text);
      else if (action.kind === "scroll") scroll(action);
      else if (action.kind === "wait") delay(action.ms / 1000);
      else if (action.kind === "open") openWith([action.path]);
      else if (action.kind === "launch" || action.kind === "focus") {
        openWith(["-a", action.application, ...(action.uri ? [action.uri] : [])]);
      } else if (action.kind === "element") {
        const target = request.elements[String(action.element)];
        if (!target) throw new Error("element " + action.element + " is not on the last screen; observe again");
        elementAction(action, target, scale);
      } else if (action.kind === "menu") pressMenu(action);
      else throw new Error("unsupported action " + action.kind);
      completed++;
      delay(0.04);
    }
  } catch (error) {
    return { completed, error: String(error && error.message ? error.message : error) };
  }
  return { completed };
}
`;

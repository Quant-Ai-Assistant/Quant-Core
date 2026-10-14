(() => {
  const bridge = window.rakazoSetup;
  document.documentElement.dataset.platform = bridge?.platform ?? "browser";

  /** The setup window runs before the web app and its catalogs, so it carries its own. */
  const RU = {
    "Set up Quant": "Настройка Quant",
    Quit: "Выйти",
    "Quit Quant": "Выйти из Quant",
    "Welcome to Quant": "Добро пожаловать в Quant",
    "Choose which server this app should use.": "Выберите сервер для этого приложения.",
    Instance: "Сервер",
    "This computer": "Этот компьютер",
    "Existing instance": "Существующий сервер",
    "Username for other devices": "Логин для других устройств",
    Password: "Пароль",
    "Technical details": "Технические подробности",
    "Setup progress": "Ход установки",
    "Server address": "Адрес сервера",
    "Username (if the server asks)": "Логин (если сервер спрашивает)",
    "Check connection": "Проверить соединение",
    Continue: "Продолжить",
    "Check again": "Проверить снова",
    Retry: "Повторить",
    "Getting ready…": "Подготовка…",
    "Downloading Quant…": "Загрузка Quant…",
    "Starting Quant…": "Запуск Quant…",
    "Almost ready…": "Почти готово…",
    "Quant is ready.": "Quant готов.",
    "{size} downloaded": "Загружено {size}",
    "Tunnel address: {url}": "Адрес для туннеля: {url}",
    "Leave empty to keep it": "Оставьте пустым, чтобы не менять",
    "Enter a password for other devices.": "Введите пароль для других устройств.",
    "Enter a username for other devices.": "Введите логин для других устройств.",
    "The username may use letters, digits, dot, dash and underscore.":
      "В логине допустимы латинские буквы, цифры, точка, дефис и подчёркивание.",
    "Connecting…": "Подключение…",
    "Checking…": "Проверка…",
    "Quant answered at {url}.": "Quant ответил по адресу {url}.",
    "Enter a server address first.": "Сначала введите адрес сервера.",
    "Could not save that address.": "Не удалось сохранить этот адрес.",
    "Could not save that address. Try again.":
      "Не удалось сохранить этот адрес. Попробуйте ещё раз.",
    "Could not reach that address.": "Не удалось связаться с этим адресом.",
    "Could not run the connection check. Try again.":
      "Не удалось проверить соединение. Попробуйте ещё раз.",
    "Could not follow the local stack. Try again.":
      "Не удалось отследить запуск сервисов. Попробуйте ещё раз.",
    "Could not start the local stack. Try again.":
      "Не удалось запустить сервисы. Попробуйте ещё раз.",
    "Setup bridge unavailable.": "Настройка недоступна.",
    "Setup could not start. Quit Quant and try again.":
      "Не удалось начать настройку. Закройте Quant и попробуйте снова.",
    "Docker is not installed on this computer.": "Docker не установлен на этом компьютере.",
    "Docker is installed but not running. Start Docker, then check again.":
      "Docker установлен, но не запущен. Запустите Docker и проверьте снова.",
    "Docker is installed, but Docker Compose is missing. Install Docker Desktop or the docker-compose-plugin.":
      "Docker установлен, но нет Docker Compose. Установите Docker Desktop или docker-compose-plugin.",
    "Downloading Quant images failed. Check the output below, then retry.":
      "Не удалось загрузить образы Quant. Посмотрите вывод ниже и повторите.",
    "Quant services did not start. Check the output below, then retry.":
      "Сервисы Quant не запустились. Посмотрите вывод ниже и повторите.",
    "Could not reach the image registry. Check the internet connection, then retry.":
      "Не удалось связаться с хранилищем образов. Проверьте интернет и повторите.",
    "Docker stopped answering. Start Docker, then retry.":
      "Docker перестал отвечать. Запустите Docker и повторите.",
    "Could not bind a local port after retrying. Retry to choose another port.":
      "Не удалось занять локальный порт. Повторите, чтобы выбрать другой.",
    "The start was interrupted. Retry to continue.": "Запуск прерван. Повторите, чтобы продолжить.",
    "Could not prepare the local stack. Retry.": "Не удалось подготовить сервисы. Повторите.",
    "Could not save the password for other devices. Retry.":
      "Не удалось сохранить пароль для других устройств. Повторите.",
    "The stack started but the web app did not answer. Retry, and check the output below.":
      "Сервисы запустились, но веб-приложение не отвечает. Повторите и посмотрите вывод ниже.",
    "The app-managed Quant services are not ready. Retry setup.":
      "Сервисы Quant ещё не готовы. Повторите настройку.",
    "A connection attempt is already running.": "Подключение уже выполняется.",
  };
  const russian = (navigator.language ?? "").toLowerCase().startsWith("ru");
  function t(text, values = {}) {
    let result = russian ? (RU[text] ?? text) : text;
    for (const [name, value] of Object.entries(values)) result = result.replace(`{${name}}`, value);
    return result;
  }
  function translatePage() {
    document.documentElement.lang = russian ? "ru" : "en";
    document.title = t(document.title);
    for (const element of document.querySelectorAll(
      "h1, .subheading, legend, .choice-title, .field-label, .button, .titlebar-quit",
    )) {
      element.textContent = t(element.textContent.trim());
    }
    for (const element of document.querySelectorAll("[title], [aria-label]")) {
      for (const name of ["title", "aria-label"]) {
        const value = element.getAttribute(name);
        if (value !== null) element.setAttribute(name, t(value));
      }
    }
  }
  translatePage();

  const form = document.getElementById("setup");
  const serverUrl = document.getElementById("server-url");
  const serverUsername = document.getElementById("server-username");
  const serverPassword = document.getElementById("server-password");
  const gateUsername = document.getElementById("gate-username");
  const gatePassword = document.getElementById("gate-password");
  const gateAddress = document.getElementById("gate-address");
  /** The gate already saved for this computer's stack, or null when other devices are shut out. */
  let savedGate = null;

  /**
   * What Continue asks of the gate: undefined keeps it, null closes it, credentials open it.
   * Returns an error message instead when the fields cannot be sent as they are.
   */
  function gateChange() {
    const username = gateUsername.value.trim();
    const password = gatePassword.value;
    if (username === "") {
      if (password !== "") return { error: "Enter a username for other devices." };
      return { access: savedGate === null ? undefined : null };
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
      return { error: "The username may use letters, digits, dot, dash and underscore." };
    }
    if (password === "") {
      if (savedGate?.username === username) return { access: undefined };
      return { error: "Enter a password for other devices." };
    }
    return { access: { username, password } };
  }

  function renderGate(gate) {
    savedGate = gate ?? null;
    if (savedGate !== null && gateUsername.value === "") gateUsername.value = savedGate.username;
    gatePassword.placeholder = savedGate === null ? "" : t("Leave empty to keep it");
    gateAddress.hidden = savedGate === null;
    gateAddress.textContent =
      savedGate === null
        ? ""
        : t("Tunnel address: {url}", { url: `http://localhost:${savedGate.port}` });
  }

  async function refreshGate() {
    try {
      const current = await bridge.state();
      if (current !== null) renderGate(current.gate);
    } catch {
      // The address only informs; the start itself reports its own failures.
    }
  }

  /** The gate's Basic Auth; an empty username means the server has none. */
  function serverAccess() {
    const username = serverUsername.value.trim();
    return username === "" ? null : { username, password: serverPassword.value };
  }
  const panelNew = document.getElementById("panel-new");
  const panelExisting = document.getElementById("panel-existing");
  const stackSection = document.getElementById("stack");
  const stackPhase = document.getElementById("stack-phase");
  const stackOutput = document.getElementById("stack-output");
  const stackDetail = document.getElementById("stack-detail");
  const stackDetails = document.getElementById("stack-details");
  const stackProgress = document.getElementById("stack-progress");
  const stackProgressFill = document.getElementById("stack-progress-fill");
  const stackDockerHelp = document.getElementById("stack-docker-help");
  const status = document.getElementById("status");
  const checkButton = document.getElementById("check");
  const continueButton = document.getElementById("continue");
  const quitButton = document.getElementById("quit");

  const STACK_POLL_MS = 1000;
  const PHASE_LABELS = {
    "checking-docker": t("Getting ready…"),
    preparing: t("Getting ready…"),
    pulling: t("Downloading Quant…"),
    starting: t("Starting Quant…"),
    "waiting-healthy": t("Almost ready…"),
    ready: t("Quant is ready."),
  };
  const TERMINAL_PHASES = new Set([
    "idle",
    "docker-missing",
    "docker-not-running",
    "ready",
    "failed",
  ]);
  const PHASE_PROGRESS = {
    "checking-docker": 0.06,
    preparing: 0.12,
    pulling: 0.2,
    starting: 0.82,
    "waiting-healthy": 0.92,
    ready: 1,
  };
  /** Docker reports bytes pulled but never a total, so the bar approaches the next phase without reaching it. */
  const PULL_SPAN = 0.6;
  const PULL_SCALE_BYTES = 1.2e9;

  let defaultLocalUrl = "";
  let stackPolling = false;
  let lastStack = null;
  let lastProgress = 0;
  let detailsOpen = false;
  /** Set when a failure opened the output; a retry closes it again, a person's own click does not. */
  let detailsOpenedByFailure = false;
  /** Resolves the poll wait early when the main process pushes a new state. */
  let wakePoll = null;

  function selectedMode() {
    const checked = form.querySelector('input[name="mode"]:checked');
    return checked === null ? "new" : checked.value;
  }

  function setStatus(message, tone) {
    status.textContent = t(message);
    if (tone === undefined) status.removeAttribute("data-tone");
    else status.setAttribute("data-tone", tone);
  }

  function setBusy(busy) {
    checkButton.disabled = busy;
    continueButton.disabled = busy;
    gateUsername.disabled = busy;
    gatePassword.disabled = busy;
  }

  /** A save in flight cannot be cancelled, so the choice it commits must not change under it. */
  function lockMode(locked) {
    for (const input of form.querySelectorAll('input[name="mode"]')) input.disabled = locked;
  }

  function syncPanels() {
    const mode = selectedMode();
    panelNew.hidden = mode !== "new";
    panelExisting.hidden = mode === "new";
    checkButton.hidden = mode === "new";
    if (mode !== "new") continueButton.textContent = t("Continue");
    setStatus("");
  }

  function isDockerPhase(phase) {
    return phase === "docker-missing" || phase === "docker-not-running";
  }

  function downloadedBytes(stack) {
    return Object.values(stack.layerBytes ?? {}).reduce((total, bytes) => total + bytes, 0);
  }

  function formatBytes(bytes) {
    if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
    if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
    if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
    return `${Math.round(bytes)} B`;
  }

  function progressFor(stack) {
    const base = PHASE_PROGRESS[stack.phase] ?? 0;
    if (stack.phase !== "pulling") return base;
    return base + PULL_SPAN * (1 - Math.exp(-downloadedBytes(stack) / PULL_SCALE_BYTES));
  }

  function renderProgress(stack) {
    const running = stack.phase in PHASE_PROGRESS;
    stackProgress.hidden = !running;
    if (!running) {
      lastProgress = 0;
      stackProgressFill.style.width = "0%";
      return;
    }
    // A retry restarts at its phase; otherwise the bar only ever moves forward.
    lastProgress =
      stack.phase === "checking-docker"
        ? progressFor(stack)
        : Math.max(lastProgress, progressFor(stack));
    const percent = (lastProgress * 100).toFixed(1);
    stackProgressFill.style.width = `${percent}%`;
    stackProgress.setAttribute("aria-valuenow", percent);
  }

  function renderDetails(stack) {
    const bytes = stack.phase === "pulling" ? downloadedBytes(stack) : 0;
    stackDetail.textContent = bytes > 0 ? t("{size} downloaded", { size: formatBytes(bytes) }) : "";

    // A new attempt clears the output, so drop an expansion the person did not ask for.
    if (stack.phase === "checking-docker" && detailsOpenedByFailure) {
      detailsOpen = false;
      detailsOpenedByFailure = false;
    }
    const hasOutput = stack.output.length > 0;
    // A failure asks the person to read the output, so open it for them.
    if (stack.phase === "failed" && hasOutput && !detailsOpen) {
      detailsOpen = true;
      detailsOpenedByFailure = true;
    }
    stackDetails.hidden = !hasOutput;
    stackDetails.setAttribute("aria-expanded", String(detailsOpen && hasOutput));
    stackOutput.hidden = !(detailsOpen && hasOutput);
    if (!stackOutput.hidden) {
      stackOutput.textContent = stack.output.join("\n");
      stackOutput.scrollTop = stackOutput.scrollHeight;
    }
  }

  function renderStack(stack) {
    const previousPhase = lastStack?.phase;
    lastStack = stack;
    const { phase } = stack;
    stackSection.hidden = phase === "idle";
    if (phase === "idle") {
      continueButton.textContent = t("Continue");
      return;
    }
    const failed = isDockerPhase(phase) || phase === "failed";
    stackPhase.textContent = (failed ? t(stack.message ?? "") : PHASE_LABELS[phase]) ?? "";
    // The gate's port is chosen during the start; show it once the services come up.
    if (phase === "starting" && previousPhase !== "starting") void refreshGate();
    if (failed) stackPhase.setAttribute("data-tone", "error");
    else if (phase === "ready") stackPhase.setAttribute("data-tone", "ok");
    else stackPhase.removeAttribute("data-tone");

    renderProgress(stack);
    renderDetails(stack);
    stackDockerHelp.hidden = !isDockerPhase(phase);

    if (isDockerPhase(phase)) continueButton.textContent = t("Check again");
    else if (phase === "failed") continueButton.textContent = t("Retry");
    else continueButton.textContent = t("Continue");
    setBusy(!TERMINAL_PHASES.has(phase));
  }

  async function save(mode, url) {
    setBusy(true);
    lockMode(true);
    setStatus("Connecting…");
    try {
      const saved = await bridge.save(
        mode === "existing"
          ? { mode, serverUrl: url, access: serverAccess() }
          : { mode, serverUrl: url },
      );
      if (!saved.ok) setStatus(saved.error ?? "Could not save that address.", "error");
    } catch {
      setStatus("Could not save that address. Try again.", "error");
    } finally {
      lockMode(false);
      setBusy(false);
    }
  }

  /** Wakes on the next pushed state, and on the timer if a push is ever missed. */
  function waitForStackChange() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        if (wakePoll === finish) wakePoll = null;
        resolve();
      };
      wakePoll = finish;
      setTimeout(finish, STACK_POLL_MS);
    });
  }

  /**
   * Follows a start already in flight until it settles. Leaving "This computer"
   * ends the follow so the stack becoming ready never saves over that choice.
   */
  async function followStack() {
    if (stackPolling) return;
    stackPolling = true;
    try {
      while (true) {
        const stack = await bridge.stack.state();
        if (stack === null) throw new Error("Setup is not active");
        // Checked after the await: a mode change during it hands the form to the change
        // handler, and a save it started must stay busy and must not be re-rendered over.
        if (selectedMode() !== "new") return;
        renderStack(stack);
        if (TERMINAL_PHASES.has(stack.phase)) {
          if (stack.phase === "ready" && selectedMode() === "new") {
            const current = await bridge.state();
            if (selectedMode() !== "new") return;
            defaultLocalUrl = current.defaultLocalUrl;
            await save("new", defaultLocalUrl);
          }
          return;
        }
        await waitForStackChange();
      }
    } catch {
      setStatus("Could not follow the local stack. Try again.", "error");
      setBusy(false);
    } finally {
      stackPolling = false;
    }
  }

  async function runStack() {
    const gate = gateChange();
    if (gate.error !== undefined) {
      setStatus(gate.error, "error");
      return;
    }
    setStatus("");
    setBusy(true);
    try {
      // A queued start still reads `idle`; leave the panel as it is and let the follow render it.
      const started = await bridge.stack.start({ access: gate.access });
      if (started !== null && started.phase !== "idle") renderStack(started);
    } catch {
      setStatus("Could not start the local stack. Try again.", "error");
      setBusy(false);
      return;
    }
    await followStack();
  }

  async function check() {
    const value = serverUrl.value;
    if (value.trim() === "") {
      setStatus("Enter a server address first.", "error");
      return null;
    }

    setBusy(true);
    setStatus("Checking…");
    try {
      const result = await bridge.test({ url: value, access: serverAccess() });
      if (result.ok) {
        serverUrl.value = result.url;
        setStatus(t("Quant answered at {url}.", { url: result.url }), "ok");
      } else {
        setStatus(result.error ?? "Could not reach that address.", "error");
      }
      return result;
    } catch {
      setStatus("Could not run the connection check. Try again.", "error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener("change", (event) => {
    if (event.target instanceof HTMLInputElement && event.target.name === "mode") {
      syncPanels();
      // Unlock Continue/Check immediately; followStack exits on its next poll.
      if (selectedMode() !== "new") setBusy(false);
    }
  });

  checkButton.addEventListener("click", () => {
    void check();
  });

  stackDetails.addEventListener("click", () => {
    detailsOpen = !detailsOpen;
    detailsOpenedByFailure = false;
    if (lastStack !== null) renderDetails(lastStack);
  });

  stackDockerHelp.addEventListener("click", (event) => {
    const link = event.target instanceof HTMLElement ? event.target.dataset.link : undefined;
    if (link) void bridge.openLink(link);
  });

  quitButton.addEventListener("click", () => {
    if (bridge === undefined) {
      window.close();
      return;
    }
    void bridge.quit();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (selectedMode() === "new") void runStack();
    else void save("existing", serverUrl.value);
  });

  /** Pushed state keeps progress moving even when the OS throttles this window's timers. */
  function watchStack() {
    bridge.stack.onChange(() => {
      wakePoll?.();
      // A follow that ended on an error restarts here instead of leaving the panel frozen;
      // hold the controls until it has rendered the state it is restarting on.
      if (!stackPolling && selectedMode() === "new") {
        setBusy(true);
        void followStack();
      }
    });
  }

  async function init() {
    if (bridge === undefined) {
      setStatus("Setup bridge unavailable.", "error");
      setBusy(true);
      return;
    }

    watchStack();
    try {
      const state = await bridge.state();
      if (state === null) throw new Error("Setup is not active");
      defaultLocalUrl = state.defaultLocalUrl;
      renderGate(state.gate);
      if (state.saved !== null) {
        const modeInput = document.querySelector(`input[name="mode"][value="${state.saved.mode}"]`);
        if (modeInput !== null) modeInput.checked = true;
        if (state.saved.mode === "existing") serverUrl.value = state.saved.serverUrl;
        if (state.savedUsername) serverUsername.value = state.savedUsername;
      }
      // A relaunch with the stack down starts it before this window opens; show that
      // attempt instead of the saved mode, and follow it while it is still running.
      const stack = await bridge.stack.state();
      const attached = stack !== null && stack.phase !== "idle";
      if (attached) document.getElementById("mode-new").checked = true;
      syncPanels();
      if (state.error) setStatus(state.error, "error");
      if (attached) {
        renderStack(stack);
        if (!TERMINAL_PHASES.has(stack.phase)) void followStack();
      } else if (selectedMode() === "existing") {
        serverUrl.focus();
      } else {
        continueButton.focus();
      }
    } catch {
      setStatus("Setup could not start. Quit Quant and try again.", "error");
      setBusy(true);
    }
  }

  void init();
})();

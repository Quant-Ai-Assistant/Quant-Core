(() => {
  const bridge = window.rakazoSetup;
  document.documentElement.dataset.platform = bridge?.platform ?? "browser";

  /** The setup window runs before the web app and its catalogs, so it carries its own. */
  const RU = {
    "Set up Quant": "Настройка Quant",
    Quit: "Выйти",
    "Quit Quant": "Выйти из Quant",
    "Where will Quant run?": "Где будет работать Quant?",
    Instance: "Сервер",
    "This computer": "Этот компьютер",
    "Server inside the app": "Сервер внутри приложения",
    "Another server": "Другой сервер",
    "Connect by address": "Подключиться по адресу",
    "Step {step} of {count}": "Шаг {step} из {count}",
    "Sign-in from other devices": "Вход с других устройств",
    Username: "Логин",
    Password: "Пароль",
    "Phones and browsers ask for these when they connect.":
      "Телефон и браузер спросят их при входе.",
    Port: "Порт",
    "Installing Quant": "Установка Quant",
    "Starting Quant": "Запуск Quant",
    "Connect to a server": "Подключение к серверу",
    "Technical details": "Технические подробности",
    "Setup progress": "Ход установки",
    "Server address": "Адрес сервера",
    "Username (if the server asks)": "Логин (если сервер спрашивает)",
    "Check connection": "Проверить соединение",
    Back: "Назад",
    Next: "Далее",
    Install: "Установить",
    Continue: "Продолжить",
    "Check again": "Проверить снова",
    Retry: "Повторить",
    "Getting ready…": "Подготовка…",
    "Moving your data into the app…": "Перенос данных в приложение…",
    "Starting Quant…": "Запуск Quant…",
    "Almost ready…": "Почти готово…",
    "Quant is ready.": "Quant готов.",
    "Tunnel address: {url}": "Адрес для туннеля: {url}",
    "Leave empty to keep it": "Оставьте пустым, чтобы не менять",
    "Enter a username.": "Введите логин.",
    "Enter a password.": "Введите пароль.",
    "The username may use letters, digits, dot, dash and underscore.":
      "В логине допустимы латинские буквы, цифры, точка, дефис и подчёркивание.",
    "Enter a port from 1024 to 65535.": "Введите порт от 1024 до 65535.",
    "Port {port} is busy. Choose another.": "Порт {port} занят. Выберите другой.",
    "Could not check that port. Try again.": "Не удалось проверить порт. Попробуйте ещё раз.",
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
    "The start was interrupted. Retry to continue.": "Запуск прерван. Повторите, чтобы продолжить.",
    "Could not prepare the local stack. Retry.": "Не удалось подготовить сервисы. Повторите.",
    "Could not prepare the local server. Retry.": "Не удалось подготовить сервер. Повторите.",
    "The database did not start. Check the output below, then retry.":
      "База данных не запустилась. Посмотрите вывод ниже и повторите.",
    "Could not update the database. Check the output below, then retry.":
      "Не удалось обновить базу данных. Посмотрите вывод ниже и повторите.",
    "The server started but did not answer. Retry, and check the output below.":
      "Сервер запустился, но не отвечает. Повторите и посмотрите вывод ниже.",
    "This build has no local server. Reinstall Quant.":
      "В этой сборке нет локального сервера. Переустановите Quant.",
    "Quant could not reach Docker to move your existing data into the app. Start Docker, then retry.":
      "Quant не смог связаться с Docker, чтобы перенести ваши данные в приложение. Запустите Docker и повторите.",
    "Docker is out of disk space, so Quant cannot read your existing data. Free some space in Docker, then retry.":
      "В Docker закончилось место на диске, поэтому Quant не может прочитать ваши данные. Освободите место в Docker и повторите.",
    "Quant could not move your existing data from Docker. Check the output below, then retry.":
      "Quant не смог перенести ваши данные из Docker. Посмотрите вывод ниже и повторите.",
    "Port {port} is busy. Choose another port in setup.":
      "Порт {port} занят. Выберите другой порт в настройке.",
    "The app-managed Quant services are not ready. Retry setup.":
      "Сервисы Quant ещё не готовы. Повторите настройку.",
    "A connection attempt is already running.": "Подключение уже выполняется.",
  };

  const russian = (navigator.language ?? "").toLowerCase().startsWith("ru");
  function t(text, values = {}) {
    const busy = /^Port (\d+) is busy\. Choose another port in setup\.$/.exec(text);
    if (busy) return t("Port {port} is busy. Choose another port in setup.", { port: busy[1] });
    let result = russian ? (RU[text] ?? text) : text;
    for (const [name, value] of Object.entries(values)) result = result.replace(`{${name}}`, value);
    return result;
  }
  function translatePage() {
    document.documentElement.lang = russian ? "ru" : "en";
    document.title = t(document.title);
    for (const element of document.querySelectorAll(
      "h1, legend, .choice-title, .choice-hint, .field-label, .field-hint, .button, .titlebar-quit",
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
  const gatePort = document.getElementById("gate-port");
  const gateAddress = document.getElementById("gate-address");
  const installAddress = document.getElementById("install-address");
  const installHeading = document.querySelector("#step-install .heading");
  const stepCount = document.getElementById("step-count");
  const stackPhase = document.getElementById("stack-phase");
  const stackOutput = document.getElementById("stack-output");
  const stackDetails = document.getElementById("stack-details");
  const stackProgress = document.getElementById("stack-progress");
  const stackProgressFill = document.getElementById("stack-progress-fill");
  const status = document.getElementById("status");
  const backButton = document.getElementById("back");
  const checkButton = document.getElementById("check");
  const continueButton = document.getElementById("continue");
  const quitButton = document.getElementById("quit");

  /** Steps of each path; `install` follows `port` and is not counted. */
  const PATHS = { new: ["choose", "access", "port"], existing: ["choose", "existing"] };
  const STEPS = ["choose", "access", "port", "install", "existing"];
  const PORT_MIN = 1024;
  const PORT_MAX = 65535;

  const STACK_POLL_MS = 1000;
  const PHASE_LABELS = {
    preparing: t("Getting ready…"),
    importing: t("Moving your data into the app…"),
    starting: t("Starting Quant…"),
    "waiting-healthy": t("Almost ready…"),
    ready: t("Quant is ready."),
  };
  const TERMINAL_PHASES = new Set(["idle", "ready", "failed"]);
  const PHASE_PROGRESS = {
    preparing: 0.1,
    importing: 0.3,
    starting: 0.7,
    "waiting-healthy": 0.85,
    ready: 1,
  };

  let step = "choose";
  /** The gate already saved for this computer's stack, or null before the first install. */
  let savedGate = null;
  let defaultPort = 8080;
  /** What Install sent, so Retry repeats the same start. */
  let pendingStart = null;
  let defaultLocalUrl = "";
  let stackPolling = false;
  let lastStack = null;
  let lastProgress = 0;
  let detailsOpen = false;
  /** Set when a failure opened the output; a retry closes it again, a person's own click does not. */
  let detailsOpenedByFailure = false;
  /** Resolves the poll wait early when the main process pushes a new state. */
  let wakePoll = null;
  let busy = false;
  /** Whether this window started the stack; a launch's own start fails back to step 1. */
  let stackStartedHere = false;

  function selectedMode() {
    const checked = form.querySelector('input[name="mode"]:checked');
    return checked === null ? "new" : checked.value;
  }

  function setStatus(message, tone) {
    status.textContent = t(message);
    if (tone === undefined) status.removeAttribute("data-tone");
    else status.setAttribute("data-tone", tone);
  }

  /** A failed start, or a ready one whose save failed, offers Back and Retry. */
  function stackSettled() {
    if (lastStack === null) return false;
    const { phase } = lastStack;
    return phase === "failed" || (phase === "ready" && !busy);
  }

  /** Shows the controls the current step offers; a busy step keeps them but disables them. */
  function renderActions() {
    const install = step === "install";
    backButton.hidden = step === "choose" || (install && !stackSettled());
    checkButton.hidden = step !== "existing";
    continueButton.hidden = install && !stackSettled();
    if (step === "port") continueButton.textContent = t("Install");
    else if (step === "existing") continueButton.textContent = t("Continue");
    else if (install) continueButton.textContent = t("Retry");
    else continueButton.textContent = t("Next");
    for (const control of [backButton, checkButton, continueButton]) control.disabled = busy;
    for (const input of form.querySelectorAll("input")) input.disabled = busy;
  }

  function setBusy(value) {
    busy = value;
    renderActions();
  }

  function renderStepCount() {
    const path = PATHS[selectedMode()];
    const index = path.indexOf(step);
    stepCount.textContent =
      index === -1 ? "" : t("Step {step} of {count}", { step: index + 1, count: path.length });
  }

  function showStep(next) {
    step = next;
    for (const name of STEPS) document.getElementById(`step-${name}`).hidden = name !== next;
    renderStepCount();
    renderActions();
    setStatus("");
    const focus = {
      choose: form.querySelector('input[name="mode"]:checked'),
      access: gateUsername.value === "" ? gateUsername : gatePassword,
      port: gatePort,
      existing: serverUrl,
    }[next];
    focus?.focus();
  }

  function tunnelAddress(port) {
    return t("Tunnel address: {url}", { url: `http://localhost:${port}` });
  }

  /** The port typed so far, or null when it is not a usable port. */
  function portValue() {
    const raw = gatePort.value.trim();
    if (!/^\d{1,5}$/.test(raw)) return null;
    const port = Number(raw);
    return port >= PORT_MIN && port <= PORT_MAX ? port : null;
  }

  function renderPortAddress() {
    const port = portValue();
    gateAddress.textContent = port === null ? "" : tunnelAddress(port);
  }

  /**
   * What Install asks of the gate: undefined keeps the saved one, credentials replace it.
   * Returns an error message instead when the fields cannot be sent as they are.
   */
  function gateChange() {
    const username = gateUsername.value.trim();
    const password = gatePassword.value;
    if (username === "") return { error: "Enter a username." };
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) {
      return { error: "The username may use letters, digits, dot, dash and underscore." };
    }
    if (password === "") {
      if (savedGate?.username === username) return { access: undefined };
      return { error: "Enter a password." };
    }
    return { access: { username, password } };
  }

  function renderGate(gate) {
    savedGate = gate ?? null;
    if (savedGate !== null && gateUsername.value === "") gateUsername.value = savedGate.username;
    gatePassword.placeholder = savedGate === null ? "" : t("Leave empty to keep it");
    if (gatePort.value === "") gatePort.value = String(savedGate?.port ?? defaultPort);
    renderPortAddress();
    installAddress.textContent = tunnelAddress(savedGate?.port ?? defaultPort);
  }

  /** The gate's Basic Auth; an empty username means the server has none. */
  function serverAccess() {
    const username = serverUsername.value.trim();
    return username === "" ? null : { username, password: serverPassword.value };
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
    const progress = PHASE_PROGRESS[stack.phase];
    lastProgress = stack.phase === "preparing" ? progress : Math.max(lastProgress, progress);
    const percent = (lastProgress * 100).toFixed(1);
    stackProgressFill.style.width = `${percent}%`;
    stackProgress.setAttribute("aria-valuenow", percent);
  }

  function renderDetails(stack) {
    // A new attempt clears the output, so drop an expansion the person did not ask for.
    if (stack.phase === "preparing" && detailsOpenedByFailure) {
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
    lastStack = stack;
    const { phase } = stack;
    const failed = phase === "failed";
    stackPhase.textContent = (failed ? t(stack.message ?? "") : PHASE_LABELS[phase]) ?? "";
    if (failed) stackPhase.setAttribute("data-tone", "error");
    else if (phase === "ready") stackPhase.setAttribute("data-tone", "ok");
    else stackPhase.removeAttribute("data-tone");

    renderProgress(stack);
    renderDetails(stack);
    setBusy(!TERMINAL_PHASES.has(phase));
  }

  async function save(mode, url) {
    setBusy(true);
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

  /** Follows a start already in flight until it settles, then opens the app once it is ready. */
  /**
   * A start that failed on its own at launch goes back to the first step, with the reason, so
   * the person can change the sign-in or the port before trying again.
   */
  function failBackToStart(stack) {
    document.getElementById("mode-new").checked = true;
    showStep("choose");
    setStatus(stack.message ?? "Could not start the local stack. Try again.", "error");
  }

  async function followStack() {
    if (stackPolling) return;
    stackPolling = true;
    try {
      while (step === "install") {
        const stack = await bridge.stack.state();
        if (stack === null) throw new Error("Setup is not active");
        renderStack(stack);
        if (TERMINAL_PHASES.has(stack.phase)) {
          if (stack.phase === "failed" && !stackStartedHere) {
            failBackToStart(stack);
            return;
          }
          if (stack.phase === "ready") {
            const current = await bridge.state();
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
    stackStartedHere = true;
    showStep("install");
    setBusy(true);
    try {
      // A queued start still reads `idle`; leave the step as it is and let the follow render it.
      const started = await bridge.stack.start(pendingStart);
      if (started !== null && started.phase !== "idle") renderStack(started);
    } catch {
      setStatus("Could not start the local stack. Try again.", "error");
      setBusy(false);
      return;
    }
    await followStack();
  }

  /** Checks the port step and, when the port is free, starts the install. */
  async function install() {
    const gate = gateChange();
    if (gate.error !== undefined) {
      showStep("access");
      setStatus(gate.error, "error");
      return;
    }
    const port = portValue();
    if (port === null) {
      setStatus("Enter a port from 1024 to 65535.", "error");
      return;
    }
    setBusy(true);
    try {
      const checked = await bridge.stack.checkPort(port);
      if (!checked?.ok) {
        setStatus(
          checked?.busy
            ? t("Port {port} is busy. Choose another.", { port })
            : "Enter a port from 1024 to 65535.",
          "error",
        );
        return;
      }
    } catch {
      setStatus("Could not check that port. Try again.", "error");
      return;
    } finally {
      setBusy(false);
    }
    pendingStart = { access: gate.access, port };
    installAddress.textContent = tunnelAddress(port);
    await runStack();
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
      renderStepCount();
    }
  });

  gatePort.addEventListener("input", renderPortAddress);

  backButton.addEventListener("click", () => {
    if (step === "install") showStep("port");
    else if (step === "port") showStep("access");
    else showStep("choose");
  });

  checkButton.addEventListener("click", () => {
    void check();
  });

  stackDetails.addEventListener("click", () => {
    detailsOpen = !detailsOpen;
    detailsOpenedByFailure = false;
    if (lastStack !== null) renderDetails(lastStack);
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
    if (busy) return;
    if (step === "choose") showStep(selectedMode() === "new" ? "access" : "existing");
    else if (step === "access") {
      const gate = gateChange();
      if (gate.error === undefined) showStep("port");
      else setStatus(gate.error, "error");
    } else if (step === "port") void install();
    else if (step === "install") void runStack();
    else void save("existing", serverUrl.value);
  });

  /** Pushed state keeps progress moving even when the OS throttles this window's timers. */
  function watchStack() {
    bridge.stack.onChange(() => {
      wakePoll?.();
      // A follow that ended on an error restarts here instead of leaving the step frozen;
      // hold the controls until it has rendered the state it is restarting on.
      if (!stackPolling && step === "install") {
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
      defaultPort = state.defaultPort ?? defaultPort;
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
      if (stack !== null && stack.phase === "failed" && !stackStartedHere) {
        failBackToStart(stack);
        return;
      }
      if (stack !== null && stack.phase !== "idle") {
        document.getElementById("mode-new").checked = true;
        // A launch restarting the saved server is not an install.
        if (state.saved?.mode === "new") installHeading.textContent = t("Starting Quant");
        showStep("install");
        renderStack(stack);
        if (state.error) setStatus(state.error, "error");
        // A start that finished while this window opened still has to open the app.
        if (stack.phase !== "failed") void followStack();
        return;
      }
      // A saved server that could not be reopened goes straight back to its address.
      showStep(state.error && state.saved?.mode === "existing" ? "existing" : "choose");
      if (state.error) setStatus(state.error, "error");
    } catch {
      setStatus("Setup could not start. Quit Quant and try again.", "error");
      setBusy(true);
    }
  }

  void init();
})();

(() => {
  const bridge = window.quantServerOff;
  document.documentElement.dataset.platform = bridge?.platform ?? "browser";

  const RU = {
    Quit: "Выйти",
    "The server is off": "Сервер выключен",
    "Turn on": "Включить",
  };
  const russian = (navigator.language ?? "").toLowerCase().startsWith("ru");
  document.documentElement.lang = russian ? "ru" : "en";
  for (const element of document.querySelectorAll("h1, .button, .titlebar-quit")) {
    const text = element.textContent.trim();
    element.textContent = russian ? (RU[text] ?? text) : text;
  }

  const start = document.getElementById("start");
  start.addEventListener("click", () => {
    start.disabled = true;
    void bridge?.start().finally(() => {
      start.disabled = false;
    });
  });
  document.getElementById("quit").addEventListener("click", () => void bridge?.quit());
})();

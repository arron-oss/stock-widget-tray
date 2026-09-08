const API = "http://127.0.0.1:8765";
const quote = document.querySelector("#quote");
const invoke = window.__TAURI__?.core?.invoke;

function formatPrice(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number.toFixed(2) : "--";
}

async function refresh() {
  try {
    const saved = JSON.parse(localStorage.getItem("watchlist") || "[]");
    const symbol = saved.find((stock) => stock?.ticker)?.ticker || "600519";
    const response = await fetch(`${API}/quotes?symbols=${encodeURIComponent(symbol)}`, { cache: "no-store" });
    const payload = await response.json();
    const stock = payload[symbol];
    if (!stock) throw new Error("quote unavailable");
    const change = Number(stock.change);
    quote.textContent = `${stock.name || symbol} ${formatPrice(stock.price)} ${change >= 0 ? "+" : ""}${Number.isFinite(change) ? change.toFixed(2) : "--"}%`;
    quote.className = change >= 0 ? "up" : "down";
  } catch {
    quote.textContent = "自选看盘 取价中";
    quote.className = "";
  }
}

let dragStart = null;
quote.addEventListener("pointerdown", (event) => {
  dragStart = { x: event.clientX, y: event.clientY };
  const currentWindow = window.__TAURI__?.window?.getCurrentWindow;
  if (typeof currentWindow === "function") void currentWindow().startDragging();
});
quote.addEventListener("click", (event) => {
  if (dragStart && (Math.abs(event.clientX - dragStart.x) > 5 || Math.abs(event.clientY - dragStart.y) > 5)) return;
  if (typeof invoke === "function") void invoke("show_main_window");
});
refresh();
setInterval(refresh, 2000);

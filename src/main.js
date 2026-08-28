const API = "http://127.0.0.1:8765";
const seed = [
  { name: "贵州茅台", ticker: "600519", price: 0, change: 0 },
  { name: "宁德时代", ticker: "300750", price: 0, change: 0 },
  { name: "中国平安", ticker: "601318", price: 0, change: 0 },
];

let stocks = readWatchlist();
let stream;
let streamRetry;
let snapshotInFlight = false;
let fundFlowInFlight = false;
const alertLocks = new Map();
const rowRefs = new Map();
const lookupInFlight = new Set();
const stockList = document.querySelector("#stockList");

function readWatchlist() {
  try {
    const saved = JSON.parse(localStorage.getItem("watchlist"));
    return Array.isArray(saved) ? saved.slice(0, 20) : seed;
  } catch { return seed; }
}

function persistWatchlist() { localStorage.setItem("watchlist", JSON.stringify(stocks)); }
function schedulePersist() { clearTimeout(schedulePersist.timer); schedulePersist.timer = setTimeout(persistWatchlist, 2000); }

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "--";
  return number.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatFlow(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "--";
  const wan = amount / 10000;
  const sign = wan > 0 ? "+" : "";
  if (Math.abs(wan) >= 10000) return `${sign}${(wan / 10000).toFixed(2)}亿`;
  return `${sign}${wan.toFixed(0)}万`;
}

function normalizeSymbol(value) {
  const digits = value.trim().replace(/\D/g, "");
  if (!digits || digits.length > 6) return null;
  return digits.padStart(6, "0");
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 4200);
}

function saveAndRender() {
  persistWatchlist();
  renderWatchlistStructure();
  syncWatchlist();
  requestFundFlow();
}

function resizeWindowToContent() {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") return;
  requestAnimationFrame(() => {
    const rows = stockList.querySelectorAll(".stock-row");
    const listHeight = rows.length
      ? Array.from(rows).reduce((height, row) => height + row.offsetHeight, 0) + 2
      : 130;
    const desiredHeight = Math.min(680, Math.max(250, listHeight + 46 + 38 + 40 + 20));
    void invoke("resize_window", { height: desiredHeight });
  });
}

function renderWatchlistStructure() {
  rowRefs.clear();
  stockList.replaceChildren();
  if (!stocks.length) {
    stockList.innerHTML = '<div class="empty-state">在下方输入代码开始监控</div>';
    resizeWindowToContent();
    return;
  }

  const fragment = document.createDocumentFragment();
  stocks.forEach((stock) => {
    const row = document.createElement("article");
    row.className = "stock-row";
    row.dataset.ticker = stock.ticker;
    row.innerHTML = `
      <div class="row-top">
        <div class="stock-identity"><div class="stock-name"></div><span class="ticker"></span></div>
        <div class="flow-summary" aria-label="资金净流入">
          <span data-flow="super">超大单 --</span><span data-flow="large">大单 --</span><span data-flow="medium">中单 --</span><span data-flow="small">小单 --</span>
        </div>
        <div class="price-line"><span class="price">--</span><span class="change"><strong>(--)</strong></span></div>
        <button class="remove-button" data-remove title="移除" aria-label="移除">×</button>
      </div>
      <div class="row-stats">
        <span>开 <b data-stat="open">--</b></span>
        <span>高 <b data-stat="high">--</b></span>
        <span>低 <b data-stat="low">--</b></span>
      </div>
      <div class="alert-controls">
        <label class="alert-toggle" title="现价达到目标价时通知"><input type="checkbox" data-alert="high">涨到</label>
        <input class="threshold high-threshold" inputmode="decimal" data-threshold="high" value="" placeholder="目标价" aria-label="涨到目标价">
        <span class="alert-suffix">提醒</span>
        <label class="alert-toggle" title="现价达到目标价时通知"><input type="checkbox" data-alert="low">跌到</label>
        <input class="threshold low-threshold" inputmode="decimal" data-threshold="low" value="" placeholder="目标价" aria-label="跌到目标价">
        <span class="alert-suffix">提醒</span>
        <span class="alert-badge"></span>
      </div>`;

    const refs = {
      row,
      name: row.querySelector(".stock-name"),
      ticker: row.querySelector(".ticker"),
      flow: row.querySelector(".flow-summary"),
      flowSuper: row.querySelector('[data-flow="super"]'),
      flowLarge: row.querySelector('[data-flow="large"]'),
      flowMedium: row.querySelector('[data-flow="medium"]'),
      flowSmall: row.querySelector('[data-flow="small"]'),
      price: row.querySelector(".price"),
      change: row.querySelector(".change"),
      changeValue: row.querySelector(".change strong"),
      open: row.querySelector('[data-stat="open"]'),
      highPrice: row.querySelector('[data-stat="high"]'),
      lowPrice: row.querySelector('[data-stat="low"]'),
      high: row.querySelector('[data-alert="high"]'),
      low: row.querySelector('[data-alert="low"]'),
      highThreshold: row.querySelector(".high-threshold"),
      lowThreshold: row.querySelector(".low-threshold"),
      badge: row.querySelector(".alert-badge"),
    };
    rowRefs.set(stock.ticker, refs);
    updateRow(stock);
    fragment.append(row);
  });
  stockList.append(fragment);
  resizeWindowToContent();
}

function updateRow(stock) {
  const refs = rowRefs.get(stock.ticker);
  if (!refs) return;
  const numericChange = Number(stock.change);
  const change = Number.isFinite(numericChange) ? numericChange : 0;
  refs.name.textContent = stock.name || stock.ticker;
  refs.ticker.textContent = stock.ticker;
  refs.price.textContent = formatPrice(stock.price);
  refs.changeValue.textContent = Number.isFinite(numericChange) ? `(${change >= 0 ? "+" : ""}${change.toFixed(2)}%)` : "(--)";
  refs.change.classList.toggle("up", change >= 0);
  refs.change.classList.toggle("down", change < 0);
  [
    [refs.flowSuper, stock.flowSuper],
    [refs.flowLarge, stock.flowLarge],
    [refs.flowMedium, stock.flowMedium],
    [refs.flowSmall, stock.flowSmall],
  ].forEach(([element, value]) => {
    const amount = Number(value);
    element.textContent = `${element.dataset.flow === "super" ? "超大单" : element.dataset.flow === "large" ? "大单" : element.dataset.flow === "medium" ? "中单" : "小单"} ${formatFlow(amount)}`;
    element.classList.toggle("flow-up", Number.isFinite(amount) && amount > 0);
    element.classList.toggle("flow-down", Number.isFinite(amount) && amount < 0);
  });
  refs.open.textContent = formatPrice(stock.dayOpen);
  refs.highPrice.textContent = formatPrice(stock.dayHigh);
  refs.lowPrice.textContent = formatPrice(stock.dayLow);
  refs.high.checked = Boolean(stock.highEnabled);
  refs.low.checked = Boolean(stock.lowEnabled);
  if (document.activeElement !== refs.highThreshold) refs.highThreshold.value = stock.high ?? "";
  if (document.activeElement !== refs.lowThreshold) refs.lowThreshold.value = stock.low ?? "";
  refs.badge.textContent = stock.highEnabled || stock.lowEnabled ? "预警中" : "";
}

async function addStock(value) {
  const ticker = normalizeSymbol(value);
  if (!ticker) return showToast("请输入有效的 6 位股票代码");
  if (stocks.some((stock) => stock.ticker === ticker)) return showToast("这只股票已经在自选中");
  if (stocks.length >= 20) return showToast("自选最多添加 20 只股票");
  if (lookupInFlight.has(ticker)) return;
  lookupInFlight.add(ticker);
  try {
    const response = await fetch(`${API}/lookup?symbol=${ticker}`, { cache: "no-store" });
    if (!response.ok) throw new Error("lookup failed");
    const result = await response.json();
    const quote = result[ticker];
    if (!quote?.name) return showToast("未找到这个股票代码，请检查后重试");
    if (stocks.some((stock) => stock.ticker === ticker)) return;
    stocks.push({ name: quote.name, ticker, price: Number(quote.price) || 0, change: Number(quote.change) || 0, delta: Number(quote.delta) || 0 });
    saveAndRender();
    requestSnapshot();
  } catch { showToast("暂时无法校验代码，请确认行情服务已连接"); }
  finally { lookupInFlight.delete(ticker); }
}

function removeStock(ticker) {
  stocks = stocks.filter((stock) => stock.ticker !== ticker);
  alertLocks.delete(`${ticker}:high`);
  alertLocks.delete(`${ticker}:low`);
  saveAndRender();
}

async function sendSystemAlert(title, body) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (typeof invoke !== "function") return false;
  try {
    await invoke("send_notification", { title, body });
    return true;
  } catch {
    return false;
  }
}

async function requestSystemAlertPermission() {
  return typeof window.__TAURI__?.core?.invoke === "function";
}

function checkAlerts(stock) {
  const price = Number(stock.price);
  if (!Number.isFinite(price) || price <= 0) return;
  [{ kind: "high", enabled: stock.highEnabled, threshold: stock.high, text: "涨到" }, { kind: "low", enabled: stock.lowEnabled, threshold: stock.low, text: "跌到" }].forEach(({ kind, enabled, threshold, text }) => {
    if (!enabled || !threshold) return;
    const key = `${stock.ticker}:${kind}`;
    const active = kind === "high" ? price >= threshold : price <= threshold;
    if (active && !alertLocks.get(key)) {
      void sendSystemAlert(`${stock.name} 价格预警`, `现价 ${formatPrice(price)}，已${text} ${formatPrice(threshold)}`);
      alertLocks.set(key, true);
    }
    if (!active) alertLocks.set(key, false);
  });
}

function applyQuotes(quotes) {
  let nameChanged = false;
  let auctionQuote;
  stocks.forEach((stock) => {
    const quote = quotes[stock.ticker];
    if (!quote) return;
    if (quote.name && quote.name !== stock.name) nameChanged = true;
    Object.assign(stock, {
      name: quote.name || stock.name,
      price: Number(quote.price), change: Number(quote.change), delta: Number(quote.delta),
      dayOpen: Number(quote.day_open), dayHigh: Number(quote.day_high), dayLow: Number(quote.day_low), volume: Number(quote.volume),
      updatedAt: Number(quote.updated_at) || stock.updatedAt,
      latencyMs: Number(quote.latency_ms) || null, source: quote.source || stock.source,
    });
    updateRow(stock);
    checkAlerts(stock);
  });
  Object.values(quotes).some((quote) => {
    if (quote.session === "auction" && quote.auction_price) { auctionQuote = quote; return true; }
    return false;
  });
  if (nameChanged) schedulePersist();
  const hasQuote = stocks.some((stock) => Number(stock.price) > 0);
  setConnection(hasQuote ? "online" : "pending", hasQuote ? "实时" : "取价中");
  const auctionState = document.querySelector("#auctionState");
  if (auctionQuote) {
    const change = Number(auctionQuote.auction_change);
    auctionState.hidden = false;
    auctionState.textContent = `竞价 ${formatPrice(auctionQuote.auction_price)} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    auctionState.classList.toggle("up", change >= 0); auctionState.classList.toggle("down", change < 0);
  } else auctionState.hidden = true;
}

async function syncWatchlist() {
  try { await fetch(`${API}/watch?symbols=${encodeURIComponent(stocks.map((stock) => stock.ticker).join(","))}`, { cache: "no-store" }); } catch { /* reconnect handles state */ }
}

async function requestFundFlow() {
  if (fundFlowInFlight || !stocks.length) return;
  fundFlowInFlight = true;
  try {
    const symbols = stocks.map((stock) => stock.ticker).join(",");
    const response = await fetch(`${API}/fund-flow?symbols=${encodeURIComponent(symbols)}`, { cache: "no-store" });
    if (!response.ok) throw new Error("fund flow unavailable");
    const flows = await response.json();
    stocks.forEach((stock) => {
      const flow = flows[stock.ticker];
      if (!flow) return;
      Object.assign(stock, {
        flowSuper: Number(flow.flow_super),
        flowLarge: Number(flow.flow_large),
        flowMedium: Number(flow.flow_medium),
        flowSmall: Number(flow.flow_small),
        flowUpdatedAt: Number(flow.flow_updated_at),
        flowSource: flow.flow_source,
      });
      updateRow(stock);
    });
  } catch {
    // 资金流失败不影响现价行情。
  } finally {
    fundFlowInFlight = false;
  }
}

async function requestSnapshot() {
  if (snapshotInFlight || !stocks.length) return;
  snapshotInFlight = true;
  try {
    const response = await fetch(`${API}/quotes?symbols=${encodeURIComponent(stocks.map((stock) => stock.ticker).join(","))}`, { cache: "no-store" });
    if (!response.ok) throw new Error("quote server unavailable");
    applyQuotes(await response.json());
  } catch {
    setConnection("offline", "离线");
  } finally { snapshotInFlight = false; }
}

function connectStream() {
  if (stream) stream.close();
  stream = new EventSource(`${API}/stream`);
  stream.onopen = () => { clearTimeout(streamRetry); requestSnapshot(); };
  stream.onmessage = (event) => { try { applyQuotes(JSON.parse(event.data)); } catch { /* ignore malformed event */ } };
  stream.onerror = () => { stream.close(); setConnection("offline", "重连中"); clearTimeout(streamRetry); streamRetry = setTimeout(connectStream, 1500); };
}

function setConnection(state, text) {
  document.querySelector("#connection").dataset.state = state;
  document.querySelector("#connectionText").textContent = text;
}

function updateMarketState() {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short", hour12: false, hour: "2-digit", minute: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const minutes = Number(values.hour) * 60 + Number(values.minute);
  const weekday = !["Sat", "Sun"].includes(values.weekday);
  let state = "closed"; let label = "收盘";
  if (weekday && minutes >= 555 && minutes < 565) { state = "auction"; label = "集合竞价"; }
  else if (weekday && ((minutes >= 570 && minutes < 690) || (minutes >= 780 && minutes < 900))) { state = "open"; label = "开盘"; }
  else if (weekday && ((minutes >= 565 && minutes < 570) || (minutes >= 690 && minutes < 780))) { state = "break"; label = minutes < 570 ? "开盘前" : "午间休市"; }
  const element = document.querySelector("#marketState"); element.dataset.state = state; element.textContent = label;
}

function updateBeijingClock() {
  const text = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
  document.querySelector("#beijingTime").textContent = `北京时间 ${text}`;
}

stockList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (button) removeStock(button.closest(".stock-row").dataset.ticker);
});

let swipeState;
stockList.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest("button, input, label")) return;
  const row = event.target.closest(".stock-row");
  if (!row) return;
  swipeState = { row, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, dx: 0 };
  row.setPointerCapture(event.pointerId);
});
stockList.addEventListener("pointermove", (event) => {
  if (!swipeState || event.pointerId !== swipeState.pointerId) return;
  const dx = event.clientX - swipeState.startX;
  const dy = event.clientY - swipeState.startY;
  if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { swipeState.row.releasePointerCapture(event.pointerId); swipeState = null; return; }
  swipeState.dx = Math.min(0, dx);
  if (swipeState.dx < -4) {
    event.preventDefault();
    swipeState.row.classList.add("is-swiping");
    swipeState.row.style.setProperty("--swipe-x", `${swipeState.dx}px`);
  }
});
function finishSwipe(event) {
  if (!swipeState || event.pointerId !== swipeState.pointerId) return;
  const { row, dx } = swipeState;
  swipeState = null;
  row.classList.remove("is-swiping");
  row.style.removeProperty("--swipe-x");
  if (dx <= -90) {
    row.classList.add("is-removing");
    setTimeout(() => removeStock(row.dataset.ticker), 130);
  }
}
stockList.addEventListener("pointerup", finishSwipe);
stockList.addEventListener("pointercancel", finishSwipe);

stockList.addEventListener("change", async (event) => {
  const input = event.target;
  const row = input.closest(".stock-row");
  if (!row) return;
  const stock = stocks.find((item) => item.ticker === row.dataset.ticker);
  if (!stock) return;
  if (input.matches("[data-alert]")) {
    stock[`${input.dataset.alert}Enabled`] = input.checked;
    if (input.checked && !(await requestSystemAlertPermission())) showToast("系统通知未开启，请在 Windows 通知设置中允许本程序");
  } else if (input.matches("[data-threshold]")) stock[input.dataset.threshold] = Number(input.value) || null;
  persistWatchlist(); updateRow(stock); checkAlerts(stock);
});

document.querySelector("#addForm").addEventListener("submit", (event) => {
  event.preventDefault();
  addStock(document.querySelector("#symbolInput").value);
  document.querySelector("#symbolInput").value = "";
});
document.querySelector("#hideButton").addEventListener("click", async (event) => {
  event.preventDefault(); event.stopPropagation();
  try {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke === "function") await invoke("hide_window");
    else if (typeof window.__TAURI__?.window?.getCurrentWindow === "function") await window.__TAURI__.window.getCurrentWindow().hide();
  } catch (error) { showToast(`隐藏窗口失败：${error?.message || "请使用托盘按钮"}`); }
});

renderWatchlistStructure();
syncWatchlist();
connectStream();
requestSnapshot();
requestFundFlow();
setInterval(requestFundFlow, 60000);
updateMarketState();
updateBeijingClock();
setInterval(() => { updateMarketState(); updateBeijingClock(); }, 1000);

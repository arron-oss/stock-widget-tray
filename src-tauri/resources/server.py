"""Low-latency local quote bridge for the tray widget."""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from datetime import datetime, timedelta, timezone
import json
import re
from threading import Event, Lock, Thread
import time
from typing import Any
from urllib.parse import parse_qs, urlparse

import akshare as ak
import requests

QUOTE_CACHE: dict[str, dict[str, Any]] = {}
CACHE_LOCK = Lock()
WATCH_LOCK = Lock()
WATCH_SYMBOLS: list[str] = []
WATCH_CHANGED = Event()
HTTP = requests.Session()
STREAM_CLIENTS: set[Any] = set()
STREAM_LOCK = Lock()
FUND_FLOW_CACHE: dict[str, dict[str, Any]] = {}
FUND_FLOW_CACHE_AT = 0.0
FUND_FLOW_LOCK = Lock()

NAME_CACHE = {
    "600519": "贵州茅台", "300750": "宁德时代", "601318": "中国平安",
    "600036": "招商银行", "000858": "五粮液", "002594": "比亚迪",
    "688981": "中芯国际", "000001": "平安银行",
}
SINA_QUOTE_URL = "https://hq.sinajs.cn/list={symbols}"
SINA_HEADERS = {
    "Referer": "https://finance.sina.com.cn/",
    "User-Agent": "Mozilla/5.0 stock-widget/0.1",
}
TENCENT_QUOTE_URL = "https://qt.gtimg.cn/q={symbols}"
TENCENT_HEADERS = {"User-Agent": "Mozilla/5.0 stock-widget/0.1"}
TARGET_INTERVAL = 0.1
FUND_FLOW_INTERVAL = 45.0
FUND_FLOW_URL = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get"
FUND_FLOW_HEADERS = {"User-Agent": "Mozilla/5.0 stock-widget/0.1"}
BEIJING_TZ = timezone(timedelta(hours=8))


def beijing_now() -> datetime:
    return datetime.now(BEIJING_TZ)


def is_auction_window() -> bool:
    now = beijing_now()
    return now.weekday() < 5 and ((9, 15) <= (now.hour, now.minute) < (9, 25))


def market_symbol(symbol: str) -> str:
    if symbol.startswith(("4", "8", "92")):
        return f"bj{symbol}"
    if symbol.startswith(("5", "6", "9")):
        return f"sh{symbol}"
    return f"sz{symbol}"


def optional_float(values: list[str], index: int) -> float | None:
    try:
        value = float(values[index])
        return value if value >= 0 else None
    except (IndexError, TypeError, ValueError):
        return None


def refresh_batch(symbols: list[str]) -> None:
    """Fetch the whole watchlist in one request using AKShare's Sina provider."""
    started = time.perf_counter()
    requested = ",".join(market_symbol(symbol) for symbol in symbols)
    response = HTTP.get(
        SINA_QUOTE_URL.format(symbols=requested),
        headers=SINA_HEADERS,
        timeout=2.5,
    )
    response.raise_for_status()
    text = response.content.decode("gb18030", errors="replace")
    received_at = int(time.time() * 1000)
    latency_ms = round((time.perf_counter() - started) * 1000)
    updates: dict[str, dict[str, Any]] = {}

    for symbol, values_text in re.findall(
        r'var hq_str_(?:sh|sz|bj)(\d{6})="([^"]*)";', text
    ):
        values = values_text.split(",")
        if len(values) < 4 or not values[0]:
            continue
        try:
            previous_close = float(values[2])
            price = float(values[3])
        except (TypeError, ValueError):
            continue
        change = ((price - previous_close) / previous_close * 100) if previous_close else 0
        open_price = optional_float(values, 1)
        high_price = optional_float(values, 4)
        low_price = optional_float(values, 5)
        volume = optional_float(values, 8)
        name = values[0].strip() or NAME_CACHE.get(symbol, symbol)
        NAME_CACHE[symbol] = name
        auction_available = is_auction_window() and price > 0
        updates[symbol] = {
            "ticker": symbol,
            "name": name,
            "price": price,
            "change": round(change, 2),
            "delta": round(price - previous_close, 2),
            "previous_close": previous_close,
            "day_open": open_price,
            "day_high": high_price,
            "day_low": low_price,
            "volume": volume,
            "updated_at": received_at,
            "latency_ms": latency_ms,
            "source": "sina-batch",
            "session": "auction" if auction_available else "continuous",
            "auction_price": price if auction_available else None,
            "auction_change": round(change, 2) if auction_available else None,
        }

    if updates:
        with CACHE_LOCK:
            QUOTE_CACHE.update(updates)
        broadcast(updates)


def refresh_tencent(symbols: list[str]) -> None:
    """Fast secondary batch provider used only when Sina is unavailable."""
    started = time.perf_counter()
    requested = ",".join(market_symbol(symbol) for symbol in symbols)
    response = HTTP.get(
        TENCENT_QUOTE_URL.format(symbols=requested),
        headers=TENCENT_HEADERS,
        timeout=2.5,
    )
    response.raise_for_status()
    received_at = int(time.time() * 1000)
    latency_ms = round((time.perf_counter() - started) * 1000)
    updates: dict[str, dict[str, Any]] = {}
    for symbol, values_text in re.findall(r'v_(?:sh|sz|bj)(\d{6})="([^"]*)";', response.text):
        values = values_text.split("~")
        if len(values) < 7 or not values[1]:
            continue
        try:
            price = float(values[3])
            previous_close = float(values[4])
        except (TypeError, ValueError):
            continue
        change = ((price - previous_close) / previous_close * 100) if previous_close else 0
        open_price = optional_float(values, 5)
        high_price = optional_float(values, 30)
        low_price = optional_float(values, 31)
        volume = optional_float(values, 6)
        name = values[1].strip() or NAME_CACHE.get(symbol, symbol)
        NAME_CACHE[symbol] = name
        auction_available = is_auction_window() and price > 0
        updates[symbol] = {
            "ticker": symbol,
            "name": name,
            "price": price,
            "change": round(change, 2),
            "delta": round(price - previous_close, 2),
            "previous_close": previous_close,
            "day_open": open_price,
            "day_high": high_price,
            "day_low": low_price,
            "volume": volume,
            "updated_at": received_at,
            "latency_ms": latency_ms,
            "source": "tencent-batch",
            "session": "auction" if auction_available else "continuous",
            "auction_price": price if auction_available else None,
            "auction_change": round(change, 2) if auction_available else None,
        }
    if updates:
        with CACHE_LOCK:
            QUOTE_CACHE.update(updates)
        broadcast(updates)


def refresh_with_akshare(symbols: list[str]) -> None:
    """Slow compatibility fallback when the batch provider is unavailable."""
    received_at = int(time.time() * 1000)
    updates: dict[str, dict[str, Any]] = {}
    for symbol in symbols:
        try:
            frame = ak.stock_bid_ask_em(symbol=symbol)
            values = dict(zip(frame["item"].astype(str), frame["value"]))
            updates[symbol] = {
                "ticker": symbol,
                "name": NAME_CACHE.get(symbol, symbol),
                "price": float(values.get("最新")),
                "change": float(values.get("涨幅", 0)),
                "updated_at": received_at,
                "latency_ms": None,
                "source": "akshare-fallback",
            }
        except Exception as error:
            print(f"[stock-widget] fallback quote failed for {symbol}: {error}")
    if updates:
        with CACHE_LOCK:
            QUOTE_CACHE.update(updates)
        broadcast(updates)


def fund_flow_symbol(symbol: str) -> dict[str, Any] | None:
    """Read the latest minute-level cumulative four-tier flow for one symbol."""
    market = "1" if symbol.startswith(("5", "6", "9")) else "0"
    params = {
        "lmt": "1",
        "klt": "1",
        "secid": f"{market}.{symbol}",
        "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
        "ut": "b2884a393a59ad64002292a3e90d46a5",
    }
    try:
        response = HTTP.get(FUND_FLOW_URL, params=params, headers=FUND_FLOW_HEADERS, timeout=3.0)
        response.raise_for_status()
        data = response.json().get("data") or {}
        klines = data.get("klines") or []
        if not klines:
            return None
        values = str(klines[-1]).split(",")
        if len(values) < 6:
            return None
        return {
            "flow_super": float(values[2]),
            "flow_large": float(values[3]),
            "flow_medium": float(values[4]),
            "flow_small": float(values[5]),
            "flow_updated_at": int(time.time() * 1000),
            "flow_source": "eastmoney-minute",
        }
    except (requests.RequestException, ValueError, TypeError, IndexError) as error:
        print(f"[stock-widget] fund flow failed for {symbol}: {error}")
        return None


def fund_flow(raw_symbols: str) -> dict[str, dict[str, Any]]:
    """Return Eastmoney's latest minute-level four-tier net fund flow."""
    symbols = [
        symbol for symbol in dict.fromkeys(part.strip() for part in raw_symbols.split(","))
        if symbol.isdigit() and len(symbol) == 6
    ]
    if not symbols:
        return {}

    global FUND_FLOW_CACHE_AT
    now = time.monotonic()
    with FUND_FLOW_LOCK:
        cache_fresh = now - FUND_FLOW_CACHE_AT < FUND_FLOW_INTERVAL
        cached = {symbol: FUND_FLOW_CACHE[symbol] for symbol in symbols if symbol in FUND_FLOW_CACHE}
    if cache_fresh and len(cached) == len(symbols):
        return cached

    updates = {}
    for symbol in symbols:
        flow = fund_flow_symbol(symbol)
        if flow:
            updates[symbol] = flow
    if updates:
        with FUND_FLOW_LOCK:
            FUND_FLOW_CACHE.update(updates)
            FUND_FLOW_CACHE_AT = now
            cached = {symbol: FUND_FLOW_CACHE[symbol] for symbol in symbols if symbol in FUND_FLOW_CACHE}

    return cached


def broadcast(updates: dict[str, dict[str, Any]]) -> None:
    """Push only changed quotes to connected local SSE clients."""
    payload = f"data: {json.dumps(updates, ensure_ascii=False)}\n\n".encode("utf-8")
    with STREAM_LOCK:
        clients = list(STREAM_CLIENTS)
    stale = []
    for client in clients:
        try:
            client.wfile.write(payload)
            client.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            stale.append(client)
    if stale:
        with STREAM_LOCK:
            for client in stale:
                STREAM_CLIENTS.discard(client)


def refresh_loop() -> None:
    failure_count = 0
    while True:
        with WATCH_LOCK:
            symbols = WATCH_SYMBOLS.copy()
        if not symbols:
            WATCH_CHANGED.wait()
            WATCH_CHANGED.clear()
            continue

        started = time.monotonic()
        try:
            refresh_batch(symbols)
            failure_count = 0
        except Exception as error:
            try:
                refresh_tencent(symbols)
                failure_count = 0
            except Exception as secondary_error:
                failure_count += 1
                print(f"[stock-widget] batch quote failed: {error}; secondary failed: {secondary_error}")
                if failure_count == 1:
                    Thread(target=refresh_with_akshare, args=(symbols,), daemon=True).start()

        elapsed = time.monotonic() - started
        # Outside trading hours, keep the cache warm without needlessly polling.
        beijing = beijing_now()
        market_open = beijing.weekday() < 5 and ((9, 15) <= (beijing.hour, beijing.minute) <= (15, 5))
        interval = TARGET_INTERVAL if market_open else 15.0
        backoff = min(5.0, interval * (2 ** min(failure_count, 4)))
        time.sleep(max(0.0, backoff - elapsed))


def set_watched_symbols(symbols: list[str]) -> None:
    global WATCH_SYMBOLS
    with WATCH_LOCK:
        if symbols == WATCH_SYMBOLS:
            return
        WATCH_SYMBOLS = symbols
    WATCH_CHANGED.set()


def quotes(raw_symbols: str) -> dict[str, dict[str, Any]]:
    symbols = [
        symbol for symbol in dict.fromkeys(part.strip() for part in raw_symbols.split(","))
        if symbol.isdigit() and len(symbol) == 6
    ]
    set_watched_symbols(symbols)
    with CACHE_LOCK:
        return {symbol: QUOTE_CACHE[symbol] for symbol in symbols if symbol in QUOTE_CACHE}


class Handler(BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_common_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/stream":
            self.send_response(200)
            self.send_common_headers()
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            with STREAM_LOCK:
                STREAM_CLIENTS.add(self)
            try:
                self.wfile.write(b": connected\n\n")
                self.wfile.flush()
                while True:
                    time.sleep(30)
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                with STREAM_LOCK:
                    STREAM_CLIENTS.discard(self)
            return
        if parsed.path == "/watch":
            symbols = parse_qs(parsed.query).get("symbols", [""])[0]
            quotes(symbols)
            self.send_response(204)
            self.send_common_headers()
            self.end_headers()
            return
        if parsed.path == "/lookup":
            symbol = parse_qs(parsed.query).get("symbol", [""])[0].strip()
            if not symbol.isdigit() or len(symbol) != 6:
                self.send_error(400, "invalid symbol")
                return
            try:
                refresh_batch([symbol])
            except Exception:
                try:
                    refresh_tencent([symbol])
                except Exception:
                    pass
            with CACHE_LOCK:
                result = {symbol: QUOTE_CACHE[symbol]} if symbol in QUOTE_CACHE else {}
            payload = json.dumps(result, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if parsed.path == "/fund-flow":
            symbols = parse_qs(parsed.query).get("symbols", [""])[0]
            payload = json.dumps(fund_flow(symbols), ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_common_headers()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if parsed.path != "/quotes":
            self.send_error(404)
            return
        symbols = parse_qs(parsed.query).get("symbols", [""])[0]
        payload = json.dumps(quotes(symbols), ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_common_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")

    def log_message(self, _format, *_args):
        return


if __name__ == "__main__":
    Thread(target=refresh_loop, daemon=True).start()
    class QuoteServer(ThreadingHTTPServer):
        daemon_threads = True

    QuoteServer(("127.0.0.1", 8765), Handler).serve_forever()

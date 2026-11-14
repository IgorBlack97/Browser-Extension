#!/usr/bin/env python3
"""Окремий збирач вартості портфеля для Home Assistant.

Плагін IBKR надсилає склад рахунку. Цей скрипт раз на годину бере ціни
з Yahoo Finance, переводить їх у долари курсом ЄЦБ і пише історію.
З курсом P2P він не пов'язаний.
"""

import argparse
import base64
import hashlib
import json
import os
import sqlite3
import sys
import urllib.parse
import urllib.request
from datetime import datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)


def find_ha_root():
    current = SCRIPT_DIR
    for _ in range(4):
        if os.path.isfile(os.path.join(current, "configuration.yaml")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    for candidate in ("/config", "/homeassistant"):
        if os.path.isdir(candidate):
            return candidate
    return SCRIPT_DIR


HA_ROOT = find_ha_root()

DB_PATH = os.environ.get("PORTFOLIO_DB_PATH", os.path.join(SCRIPT_DIR, "portfolio.db"))
WWW_DIR = os.path.join(HA_ROOT, "www")
DATA_PATH = os.environ.get("PORTFOLIO_JSON_PATH", os.path.join(SCRIPT_DIR, "portfolio-data.json"))
PUBLIC_JSON = os.path.join(WWW_DIR, "portfolio.json")
SECRETS_PATH = (
    os.path.join(SCRIPT_DIR, "secrets.yaml")
    if os.path.isfile(os.path.join(SCRIPT_DIR, "secrets.yaml"))
    else os.path.join(HA_ROOT, "secrets.yaml")
)
DASHBOARD_DIR = os.path.join(PARENT_DIR, "dashboard")

YAHOO = {
    "GOOGL": "GOOGL",
    "NKE": "NKE",
    "SMCI": "SMCI",
    "VWCE": "VWCE.DE",
    "VUAA": "VUAA.L",
    "EGLN": "EGLN.L",
    "AGGU": "AGGU.L",
    "VALU": "VALU.L",
}
REPORT_HOUR = int(os.environ.get("PORTFOLIO_REPORT_HOUR", "21"))
ALERT_PCT = float(os.environ.get("PORTFOLIO_ALERT_PCT", "3"))


def log(message):
    line = f"{datetime.now().astimezone().isoformat(timespec='seconds')} {message}"
    print(line, file=sys.stderr)
    try:
        with open(os.path.join(SCRIPT_DIR, "portfolio.log"), "a", encoding="utf-8") as handle:
            handle.write(line + "\n")
    except Exception:
        pass


def fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 portfolio-tracker/1.0"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def load_secrets():
    found = {}
    if not os.path.isfile(SECRETS_PATH):
        return found
    with open(SECRETS_PATH, "r", encoding="utf-8") as handle:
        for line in handle:
            if ":" not in line or line.strip().startswith("#"):
                continue
            key, value = line.split(":", 1)
            found[key.strip()] = value.strip().strip("'\"")
    return found


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS positions (
            ticker TEXT PRIMARY KEY,
            name TEXT,
            quantity REAL,
            avg_price REAL,
            currency TEXT,
            yahoo TEXT,
            market_value REAL,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS cash (
            currency TEXT PRIMARY KEY,
            amount REAL,
            updated_at TEXT
        );
        CREATE TABLE IF NOT EXISTS syncs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            synced_at TEXT,
            source TEXT,
            payload TEXT
        );
        CREATE TABLE IF NOT EXISTS valuations (
            bucket TEXT,
            ticker TEXT,
            price REAL,
            price_currency TEXT,
            value_usd REAL,
            source TEXT,
            PRIMARY KEY (bucket, ticker)
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );
        CREATE TABLE IF NOT EXISTS holding_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            synced_at TEXT NOT NULL,
            ticker TEXT NOT NULL,
            name TEXT,
            kind TEXT NOT NULL,
            currency TEXT,
            quantity_before REAL,
            quantity_after REAL,
            avg_before REAL,
            avg_after REAL,
            trade_qty REAL,
            trade_price REAL
        );
        """
    )
    return conn


def meta_get(conn, key):
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row["value"] if row else None


def meta_set(conn, key, value):
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))


def hour_bucket(moment=None):
    moment = moment or datetime.now().astimezone()
    return moment.replace(minute=0, second=0, microsecond=0)


def usd_rates(conn=None):
    for url in (
        "https://api.frankfurter.dev/v1/latest?base=USD",
        "https://api.frankfurter.app/latest?from=USD",
    ):
        try:
            data = fetch_json(url)
            rates = {"USD": 1.0}
            rates.update({key.upper(): float(value) for key, value in (data.get("rates") or {}).items()})
            if conn is not None:
                meta_set(conn, "fx_rates", json.dumps(rates))
                meta_set(conn, "fx_date", data.get("date") or "")
                conn.commit()
            return rates, data.get("date")
        except Exception as error:
            log(f"курс {url}: {error}")
    if conn is not None:
        saved = meta_get(conn, "fx_rates")
        if saved:
            log("використовую збережений курс")
            return json.loads(saved), meta_get(conn, "fx_date")
    raise RuntimeError("Курс ЄЦБ недоступний")


def to_usd(amount, currency, rates):
    code = (currency or "USD").upper()
    if code == "USD":
        return float(amount)
    per_usd = rates.get(code)
    if not per_usd:
        raise RuntimeError(f"немає курсу {code}")
    return float(amount) / per_usd


def close_on_or_before(timestamps, closes, target):
    price = None
    for stamp, close in zip(timestamps or [], closes or []):
        if stamp is None or close is None or stamp > target:
            continue
        price = float(close)
    return price


def previous_session_close(price, timestamps, closes):
    series = [float(close) for close in (closes or []) if close is not None]
    if not series or not price:
        return None
    if abs(series[-1] - float(price)) / float(price) < 0.0001:
        return series[-2] if len(series) > 1 else None
    return series[-1]


def change_pct(price, base):
    if not price or not base:
        return None
    return (float(price) - float(base)) / float(base) * 100


def yahoo_quote(symbol):
    encoded = urllib.parse.quote(symbol)
    data = None
    for query in ("interval=1d&range=5y", "interval=1d&range=5d"):
        try:
            data = fetch_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?{query}")
        except Exception:
            data = None
        result = (data.get("chart") or {}).get("result") or [] if data else []
        if result and (result[0].get("meta") or {}).get("regularMarketPrice") is not None:
            break
        data = None
    result = (data.get("chart") or {}).get("result") or [] if data else []
    if not result:
        raise RuntimeError(f"Yahoo без даних для {symbol}")
    meta = result[0].get("meta") or {}
    price = float(meta["regularMarketPrice"])
    previous = meta.get("chartPreviousClose") or meta.get("previousClose")
    timestamps = result[0].get("timestamp") or []
    closes = (((result[0].get("indicators") or {}).get("quote") or [{}])[0]).get("close") or []
    latest = timestamps[-1] if timestamps else 0
    return {
        "symbol": meta.get("symbol") or symbol,
        "price": price,
        "currency": (meta.get("currency") or "").upper(),
        "dayChangePct": change_pct(price, previous_session_close(price, timestamps, closes) or previous),
        "monthChangePct": change_pct(price, close_on_or_before(timestamps, closes, latest - 30 * 86400)),
        "yearChangePct": change_pct(price, close_on_or_before(timestamps, closes, latest - 365 * 86400)),
    }


def since_purchase_pct(row, value_usd, rates):
    quantity = row["quantity"]
    average = row["avg_price"]
    if not quantity or not average or not value_usd:
        return None
    try:
        cost = to_usd(float(quantity) * float(average), row["currency"], rates)
    except Exception:
        return None
    if not cost:
        return None
    return (float(value_usd) / cost - 1) * 100


def resolve_yahoo(ticker, currency, known):
    if known:
        return known
    if ticker in YAHOO:
        return YAHOO[ticker]
    for candidate in (ticker, f"{ticker}.L", f"{ticker}.DE", f"{ticker}.SW", f"{ticker}.AS"):
        try:
            quote = yahoo_quote(candidate)
        except Exception:
            continue
        if not currency or quote["currency"] == currency.upper():
            return candidate
    return YAHOO.get(ticker) or ticker


def as_float(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None
    return number


def books_from_payload(payload):
    positions = {}
    for item in payload.get("positions") or []:
        ticker = str(item.get("ticker") or "").upper()
        if not ticker:
            continue
        positions[ticker] = {
            "name": item.get("name") or ticker,
            "quantity": as_float(item.get("quantity")),
            "avg": as_float(item.get("avgPrice")),
            "currency": str(item.get("currency") or item.get("marketCurrency") or "").upper(),
        }
    cash = {}
    for item in payload.get("cash") or []:
        currency = str(item.get("currency") or "").upper()
        amount = as_float(item.get("amount"))
        if not currency or amount in (None, 0):
            continue
        cash[f"CASH.{currency}"] = {
            "name": f"Готівка {currency}",
            "quantity": amount,
            "avg": 1.0,
            "currency": currency,
        }
    return positions, cash


def books_from_db(conn):
    positions = {}
    for row in conn.execute("SELECT * FROM positions"):
        positions[row["ticker"]] = {
            "name": row["name"],
            "quantity": as_float(row["quantity"]),
            "avg": as_float(row["avg_price"]),
            "currency": row["currency"],
        }
    cash = {}
    for row in conn.execute("SELECT * FROM cash"):
        currency = row["currency"]
        cash[f"CASH.{currency}"] = {
            "name": f"Готівка {currency}",
            "quantity": as_float(row["amount"]),
            "avg": 1.0,
            "currency": currency,
        }
    return positions, cash


def added_lot_price(old_qty, old_avg, new_qty, new_avg):
    if None in (old_qty, old_avg, new_qty, new_avg):
        return None
    delta = new_qty - old_qty
    if abs(delta) < 1e-6:
        return None
    price = (new_qty * new_avg - old_qty * old_avg) / delta
    if price <= 0:
        return None
    return round(price, 6)


def describe_change(old, new, opening):
    old_qty = None if old is None else old.get("quantity")
    new_qty = None if new is None else new.get("quantity")
    old_avg = None if old is None else old.get("avg")
    new_avg = None if new is None else new.get("avg")
    if old is None and (new_qty is None or abs(new_qty) < 1e-6):
        return None
    if opening or old is None:
        return "open", new_qty, new_avg
    if new is None or new_qty is None or abs(new_qty) < 1e-6:
        return "sell", old_qty, None
    if new_qty > old_qty + 1e-6:
        return "buy", new_qty - old_qty, added_lot_price(old_qty, old_avg, new_qty, new_avg)
    if old_qty is not None and new_qty < old_qty - 1e-6:
        return "sell", old_qty - new_qty, None
    if old_avg is not None and new_avg is not None and abs(new_avg - old_avg) > max(1e-6, abs(old_avg) * 1e-4):
        return "adjust", 0, new_avg
    return None


def write_book_changes(conn, before, after, synced_at, opening):
    for ticker in sorted(set(before) | set(after)):
        old = before.get(ticker)
        new = after.get(ticker)
        described = describe_change(old, new, opening)
        if described is None:
            continue
        kind, trade_qty, trade_price = described
        if ticker.startswith("CASH."):
            trade_price = None
            if kind == "buy":
                kind = "cash_in"
            elif kind == "sell":
                kind = "cash_out"
        current = new or old
        conn.execute(
            """
            INSERT INTO holding_changes
            (synced_at, ticker, name, kind, currency, quantity_before, quantity_after, avg_before, avg_after, trade_qty, trade_price)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                synced_at,
                ticker,
                current.get("name"),
                kind,
                current.get("currency"),
                None if old is None else old.get("quantity"),
                None if new is None else new.get("quantity"),
                None if old is None else old.get("avg"),
                None if new is None else new.get("avg"),
                trade_qty,
                trade_price,
            ),
        )


def ensure_changes(conn):
    if conn.execute("SELECT COUNT(*) AS n FROM holding_changes").fetchone()["n"]:
        return
    positions, cash = {}, {}
    opening = True
    for row in conn.execute("SELECT synced_at, payload FROM syncs ORDER BY id"):
        try:
            payload = json.loads(row["payload"])
        except (TypeError, json.JSONDecodeError):
            continue
        next_positions, next_cash = books_from_payload(payload)
        when = payload.get("syncedAt") or row["synced_at"]
        write_book_changes(conn, positions, next_positions, when, opening)
        write_book_changes(conn, cash, next_cash, when, opening)
        positions, cash = next_positions, next_cash
        opening = False
    conn.commit()


def change_rows(conn):
    ensure_changes(conn)
    rows = conn.execute("SELECT * FROM holding_changes ORDER BY synced_at, id").fetchall()
    return [
        {
            "t": row["synced_at"],
            "ticker": row["ticker"],
            "name": row["name"],
            "kind": row["kind"],
            "currency": row["currency"],
            "quantityBefore": row["quantity_before"],
            "quantityAfter": row["quantity_after"],
            "avgBefore": row["avg_before"],
            "avgAfter": row["avg_after"],
            "tradeQty": row["trade_qty"],
            "tradePrice": row["trade_price"],
        }
        for row in rows
    ]


def import_snapshot(conn, payload):
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    ensure_changes(conn)
    before_positions, before_cash = books_from_db(conn)
    after_positions, after_cash = books_from_payload(payload)
    opening = conn.execute("SELECT COUNT(*) AS n FROM holding_changes").fetchone()["n"] == 0
    when = payload.get("syncedAt") or now
    write_book_changes(conn, before_positions, after_positions, when, opening)
    write_book_changes(conn, before_cash, after_cash, when, opening)
    previous = {row["ticker"]: row["yahoo"] for row in conn.execute("SELECT ticker, yahoo FROM positions")}
    conn.execute("DELETE FROM positions")
    conn.execute("DELETE FROM cash")
    for item in payload.get("positions") or []:
        ticker = str(item.get("ticker") or "").upper()
        if not ticker:
            continue
        currency = str(item.get("currency") or item.get("marketCurrency") or "").upper()
        conn.execute(
            """
            INSERT OR REPLACE INTO positions
            (ticker, name, quantity, avg_price, currency, yahoo, market_value, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                ticker,
                item.get("name") or ticker,
                item.get("quantity"),
                item.get("avgPrice"),
                currency,
                previous.get(ticker) or item.get("yahoo"),
                item.get("marketValue"),
                now,
            ),
        )
    for item in payload.get("cash") or []:
        currency = str(item.get("currency") or "").upper()
        amount = item.get("amount")
        if currency and amount not in (None, 0):
            conn.execute(
                "INSERT OR REPLACE INTO cash (currency, amount, updated_at) VALUES (?, ?, ?)",
                (currency, float(amount), now),
            )
    conn.execute(
        "INSERT INTO syncs (synced_at, source, payload) VALUES (?, ?, ?)",
        (payload.get("syncedAt") or now, payload.get("source") or "ibkr", json.dumps(payload, ensure_ascii=False)),
    )
    record_broker_point(conn, payload, now)
    conn.commit()
    publish(conn)


def record_broker_point(conn, payload, now):
    try:
        rates, _as_of = usd_rates(conn)
    except Exception as error:
        log(f"перша точка без курсу: {error}")
        return
    bucket = hour_bucket().strftime("%Y-%m-%dT%H")
    invested = 0.0
    for item in payload.get("positions") or []:
        value = item.get("marketValue")
        currency = item.get("marketCurrency") or item.get("currency")
        ticker = str(item.get("ticker") or "").upper()
        if value is None or not ticker:
            continue
        try:
            usd = to_usd(value, currency, rates)
        except Exception as error:
            log(f"{ticker}: {error}")
            continue
        invested += usd
        conn.execute(
            """
            INSERT OR REPLACE INTO valuations (bucket, ticker, price, price_currency, value_usd, source)
            VALUES (?, ?, ?, ?, ?, 'broker')
            """,
            (bucket, ticker, item.get("avgPrice"), currency, usd),
        )
    cash_usd = 0.0
    for item in payload.get("cash") or []:
        try:
            cash_usd += to_usd(item.get("amount") or 0, item.get("currency"), rates)
        except Exception as error:
            log(error)
    conn.execute(
        "INSERT OR REPLACE INTO valuations (bucket, ticker, price, price_currency, value_usd, source) VALUES (?, '__CASH__', NULL, 'USD', ?, 'broker')",
        (bucket, cash_usd),
    )
    conn.execute(
        "INSERT OR REPLACE INTO valuations (bucket, ticker, price, price_currency, value_usd, source) VALUES (?, '__INVESTED__', NULL, 'USD', ?, 'broker')",
        (bucket, invested),
    )
    conn.execute(
        "INSERT OR REPLACE INTO valuations (bucket, ticker, price, price_currency, value_usd, source) VALUES (?, '__TOTAL__', NULL, 'USD', ?, 'broker')",
        (bucket, invested + cash_usd),
    )


def mark_to_market(conn):
    log("початок оновлення цін")
    rates, fx_date = usd_rates(conn)
    bucket = hour_bucket().strftime("%Y-%m-%dT%H")
    invested = 0.0
    holdings = []
    for row in conn.execute("SELECT * FROM positions ORDER BY ticker"):
        symbol = resolve_yahoo(row["ticker"], row["currency"], row["yahoo"])
        try:
            quote = yahoo_quote(symbol)
        except Exception as error:
            log(f"{row['ticker']}: {error}")
            previous = conn.execute(
                "SELECT value_usd, price, price_currency FROM valuations WHERE ticker = ? ORDER BY bucket DESC LIMIT 1",
                (row["ticker"],),
            ).fetchone()
            if not previous:
                continue
            invested += previous["value_usd"] or 0
            holdings.append({
                "ticker": row["ticker"],
                "name": row["name"],
                "quantity": row["quantity"],
                "currency": row["currency"],
                "yahoo": symbol,
                "price": previous["price"],
                "priceCurrency": previous["price_currency"],
                "valueUsd": previous["value_usd"],
                "dayChangePct": None,
                "monthChangePct": None,
                "yearChangePct": None,
                "allChangePct": None,
                "stale": True,
            })
            continue
        conn.execute("UPDATE positions SET yahoo = ? WHERE ticker = ?", (symbol, row["ticker"]))
        quantity = row["quantity"]
        if quantity:
            native = quantity * quote["price"]
        elif row["market_value"]:
            native = row["market_value"]
            quote = {**quote, "price": row["market_value"], "currency": row["currency"] or quote["currency"]}
        else:
            continue
        usd = to_usd(native, quote["currency"], rates)
        invested += usd
        all_pct = since_purchase_pct(row, usd, rates)
        conn.execute(
            """
            INSERT OR REPLACE INTO valuations (bucket, ticker, price, price_currency, value_usd, source)
            VALUES (?, ?, ?, ?, ?, 'yahoo')
            """,
            (bucket, row["ticker"], quote["price"], quote["currency"], usd),
        )
        holdings.append({
            "ticker": row["ticker"],
            "name": row["name"],
            "quantity": row["quantity"],
            "avgPrice": row["avg_price"],
            "currency": row["currency"],
            "yahoo": symbol,
            "price": quote["price"],
            "priceCurrency": quote["currency"],
                "valueUsd": round(usd, 2),
                "dayChangePct": None if quote.get("dayChangePct") is None else round(quote["dayChangePct"], 2),
                "monthChangePct": None if quote.get("monthChangePct") is None else round(quote["monthChangePct"], 2),
                "yearChangePct": None if quote.get("yearChangePct") is None else round(quote["yearChangePct"], 2),
                "allChangePct": None if all_pct is None else round(all_pct, 2),
                "stale": False,
            })
    cash_rows = []
    cash_usd = 0.0
    for row in conn.execute("SELECT * FROM cash"):
        usd = to_usd(row["amount"], row["currency"], rates)
        cash_usd += usd
        cash_rows.append({"currency": row["currency"], "amount": row["amount"], "valueUsd": round(usd, 2)})
    total = invested + cash_usd
    for ticker, value in (("__CASH__", cash_usd), ("__INVESTED__", invested), ("__TOTAL__", total)):
        conn.execute(
            "INSERT OR REPLACE INTO valuations (bucket, ticker, price, price_currency, value_usd, source) VALUES (?, ?, NULL, 'USD', ?, 'yahoo')",
            (bucket, ticker, value),
        )
    conn.commit()
    latest = build_latest(conn, holdings, cash_rows, invested, cash_usd, rates, fx_date)
    publish(conn, latest)
    maybe_notify(conn, latest)
    return total


def series(conn, ticker):
    rows = conn.execute(
        "SELECT bucket, value_usd FROM valuations WHERE ticker = ? ORDER BY bucket",
        (ticker,),
    ).fetchall()
    return [{"t": row["bucket"], "usd": round(row["value_usd"], 2)} for row in rows]


def build_latest(conn, holdings, cash_rows, invested, cash_usd, rates, fx_date):
    total = invested + cash_usd
    history = series(conn, "__TOTAL__")
    invested_history = series(conn, "__INVESTED__")
    day = change_since(history, datetime.now().astimezone().date())
    return {
        "updatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "fxDate": fx_date,
        "usdPerEur": round(1 / rates["EUR"], 6) if rates.get("EUR") else None,
        "holdings": holdings,
        "cash": cash_rows,
        "latest": {
            "totalUsd": round(total, 2),
            "investedUsd": round(invested, 2),
            "cashUsd": round(cash_usd, 2),
            "dayChangeUsd": None if day is None else round(day[0], 2),
            "dayChangePct": None if day is None else round(day[1], 2),
        },
        "history": history[-24 * 400:],
        "investedHistory": invested_history[-24 * 400:],
        "changes": change_rows(conn),
        "reportHook": load_secrets().get("portfolio_webhook_id") or load_secrets().get("portfolio_report_webhook_id") or None,
    }


def change_since(history, today):
    if len(history) < 2:
        return None
    latest = history[-1]["usd"]
    prior = None
    for point in history:
        point_day = point["t"][:10]
        if point_day < today.isoformat():
            prior = point["usd"]
    if prior in (None, 0):
        prior = history[0]["usd"]
        if prior == latest:
            return None
    return latest - prior, (latest - prior) / prior * 100


def publish(conn, latest=None):
    if latest is None:
        rates, fx_date = ({"USD": 1}, None)
        try:
            rates, fx_date = usd_rates(conn)
        except Exception as error:
            log(error)
        holdings = []
        invested = 0.0
        for row in conn.execute("SELECT * FROM positions"):
            last = conn.execute(
                "SELECT price, price_currency, value_usd FROM valuations WHERE ticker = ? ORDER BY bucket DESC LIMIT 1",
                (row["ticker"],),
            ).fetchone()
            value = last["value_usd"] if last else 0
            invested += value or 0
            holdings.append({
                "ticker": row["ticker"],
                "name": row["name"],
                "quantity": row["quantity"],
                "currency": row["currency"],
                "yahoo": row["yahoo"],
                "price": None if not last else last["price"],
                "priceCurrency": None if not last else last["price_currency"],
                "valueUsd": round(value or 0, 2),
            })
        cash_rows = [{"currency": row["currency"], "amount": row["amount"]} for row in conn.execute("SELECT * FROM cash")]
        cash_usd = 0.0
        for item in cash_rows:
            try:
                cash_usd += to_usd(item["amount"], item["currency"], rates)
                item["valueUsd"] = round(to_usd(item["amount"], item["currency"], rates), 2)
            except Exception:
                item["valueUsd"] = None
        latest = build_latest(conn, holdings, cash_rows, invested, cash_usd, rates, fx_date)
    write_json(DATA_PATH, latest)
    publish_page(latest)
    copy_dashboard()
    log("записано дані портфеля")


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)


def page_password():
    return load_secrets().get("portfolio_page_password") or ""


def publish_page(latest):
    password = page_password()
    os.makedirs(WWW_DIR, exist_ok=True)
    write_json(PUBLIC_JSON, {"locked": True})
    vault_dir = os.path.join(WWW_DIR, "v")
    os.makedirs(vault_dir, exist_ok=True)
    if not password:
        log("сторінка закрита: додайте portfolio_page_password у secrets.yaml")
        return
    name = hashlib.sha256(password.encode("utf-8")).hexdigest() + ".json"
    for existing in os.listdir(vault_dir):
        if existing != name and existing.endswith(".json"):
            os.remove(os.path.join(vault_dir, existing))
    write_json(os.path.join(vault_dir, name), latest)


def read_portfolio():
    for path in (DATA_PATH, PUBLIC_JSON):
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(data, dict) and not data.get("locked") and data.get("latest"):
            return data
    return None


def copy_dashboard():
    if not os.path.isdir(DASHBOARD_DIR):
        return
    for folder, _dirs, files in os.walk(DASHBOARD_DIR):
        relative = os.path.relpath(folder, DASHBOARD_DIR)
        target_dir = WWW_DIR if relative == "." else os.path.join(WWW_DIR, relative)
        os.makedirs(target_dir, exist_ok=True)
        for name in files:
            source = os.path.join(folder, name)
            target_name = "portfolio.html" if relative == "." and name == "index.html" else name
            with open(source, "rb") as incoming, open(os.path.join(target_dir, target_name), "wb") as outgoing:
                outgoing.write(incoming.read())


def write_report_status(ok, detail):
    status = {"ok": bool(ok), "detail": detail, "at": int(datetime.now().timestamp() * 1000)}
    paths = [DATA_PATH]
    password = page_password()
    if password:
        name = hashlib.sha256(password.encode("utf-8")).hexdigest() + ".json"
        paths.append(os.path.join(WWW_DIR, "v", name))
    for path in paths:
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if not isinstance(data, dict) or data.get("locked"):
                continue
            data["reportStatus"] = status
            write_json(path, data)
        except (OSError, json.JSONDecodeError) as error:
            log(f"не вдалося записати статус звіту: {error}")


def send_telegram(text):
    secrets = load_secrets()
    token = os.environ.get("PORTFOLIO_TG_BOT_TOKEN") or secrets.get("portfolio_tg_bot_token")
    chat = os.environ.get("PORTFOLIO_TG_CHAT_ID") or secrets.get("portfolio_tg_chat_id")
    if not token or not chat:
        log("Telegram для портфеля не налаштований")
        return False
    body = json.dumps({
        "chat_id": chat,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if not payload.get("ok"):
        log(f"Telegram відхилив звіт: {payload}")
        return False
    return True


FUNDS = {
    "VWCE": ("stocks", "акції всього світу"),
    "VWRA": ("stocks", "акції всього світу"),
    "VWRL": ("stocks", "акції всього світу"),
    "VWRP": ("stocks", "акції всього світу"),
    "VALU": ("stocks", "акції всього світу, з малою капіталізацією"),
    "V3AA": ("stocks", "акції всього світу, з малою капіталізацією"),
    "V3AB": ("stocks", "акції всього світу, з малою капіталізацією"),
    "V3AL": ("stocks", "акції всього світу, з малою капіталізацією"),
    "VUAA": ("stocks", "акції S&P 500"),
    "CSPX": ("stocks", "акції S&P 500"),
    "SXR8": ("stocks", "акції S&P 500"),
    "VUSA": ("stocks", "акції S&P 500"),
    "IWDA": ("stocks", "акції розвинених ринків"),
    "SWDA": ("stocks", "акції розвинених ринків"),
    "EUNL": ("stocks", "акції розвинених ринків"),
    "EIMI": ("stocks", "акції ринків, що розвиваються"),
    "EQQQ": ("stocks", "акції Nasdaq-100"),
    "CNDX": ("stocks", "акції Nasdaq-100"),
    "EGLN": ("gold", "фізичне золото"),
    "SGLN": ("gold", "фізичне золото"),
    "IGLN": ("gold", "фізичне золото"),
    "SSLN": ("commodity", "фізичне срібло"),
    "AGGU": ("bonds", "глобальні облігації, хедж у долар"),
    "AGGG": ("bonds", "глобальні облігації"),
    "EUNA": ("bonds", "глобальні облігації"),
    "AGGH": ("bonds", "глобальні облігації, хедж у євро"),
    "VAGF": ("bonds", "глобальні облігації"),
}

BUCKET_LABELS = (
    ("stocks", "Акції", "📈"),
    ("bonds", "Облігації", "🏛"),
    ("gold", "Золото", "🥇"),
    ("commodity", "Сировина", "🛢️"),
    ("crypto", "Крипто", "🪙"),
    ("cash", "Готівка", "💵"),
    ("other", "Інше", "📦"),
)


def signed_pct(value):
    if value is None:
        return "—"
    return f"{value:+.1f}%"


def holding_profile(item):
    ticker = str(item.get("ticker") or "").upper()
    if ticker in FUNDS:
        return FUNDS[ticker]
    name = str(item.get("name") or "")
    if any(word in name.upper() for word in ("ETF", "UCITS", "FUND", "TRUST")):
        return "other", None
    return "stocks", None


def html_escape(value):
    return str(value).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def composition_lines(holdings, cash_usd, total_usd):
    buckets = {key: 0.0 for key, _label, _emoji in BUCKET_LABELS}
    buckets["cash"] += cash_usd or 0
    for item in holdings:
        bucket, _blurb = holding_profile(item)
        buckets[bucket] = buckets.get(bucket, 0) + (item.get("valueUsd") or 0)
    if not total_usd:
        return ["немає оцінки"]
    lines = []
    for key, label, emoji in BUCKET_LABELS:
        value = buckets.get(key) or 0
        if value <= 0:
            continue
        lines.append(f"{emoji} {label} {value / total_usd * 100:.0f}% · <b>{value:.0f} USD</b>")
    return lines or ["немає оцінки"]


def qty_text(value):
    if value is None:
        return "?"
    if abs(value - round(value)) < 1e-6:
        return str(int(round(value)))
    return f"{value:.4f}".rstrip("0").rstrip(".")


def compact_price(value):
    if abs(value) >= 100:
        return f"{value:.0f}"
    return f"{value:.2f}"


def native_quote(item, usd_per_eur):
    quantity = item.get("quantity")
    price = item.get("price")
    value_usd = item.get("valueUsd")
    currency = str(item.get("currency") or "").upper()
    quote = str(item.get("priceCurrency") or currency).upper()
    if quantity and price is not None and quote == currency:
        return quantity * float(price), float(price), currency or quote
    if value_usd is not None and quantity and currency == "USD":
        total = float(value_usd)
        return total, total / quantity, "USD"
    if value_usd is not None and quantity and currency == "EUR" and usd_per_eur:
        total = float(value_usd) / usd_per_eur
        return total, total / quantity, "EUR"
    if quantity and price is not None:
        return quantity * float(price), float(price), quote or currency or "USD"
    return None, None, currency or "USD"


def position_line(item, usd_per_eur):
    _bucket, blurb = holding_profile(item)
    ticker = html_escape(item.get("ticker"))
    title = f"{ticker} ({html_escape(blurb)})" if blurb else ticker
    day = item.get("dayChangePct")
    if day is None or day == 0:
        mark = "⚪️"
    elif day > 0:
        mark = "🟢"
    else:
        mark = "🔴"
    total, unit, currency = native_quote(item, usd_per_eur)
    if total is None:
        deal = title
    else:
        deal = (
            f"{title} => {qty_text(item.get('quantity'))} x {compact_price(unit)} {currency}"
            f" | <b>{total:.0f} {currency}</b>"
        )
    return f"{mark} {deal} ({signed_pct(day)} | {signed_pct(item.get('monthChangePct'))})"


def format_report(latest, title):
    now = latest["latest"]
    day = now.get("dayChangePct")
    day_usd = now.get("dayChangeUsd")
    if day is None:
        day_emoji = "⚖️"
        day_text = "ще немає вчорашньої точки"
    else:
        day_emoji = "📈" if day > 0 else "📉" if day < 0 else "⚖️"
        money = "" if day_usd is None else f" ({day_usd:+.0f} USD)"
        day_text = f"<b>{day:+.2f}%</b>{money}"
    holdings = sorted(latest.get("holdings") or [], key=lambda item: item.get("valueUsd") or 0, reverse=True)
    usd_per_eur = latest.get("usdPerEur")
    lines = [
        f"📊 <b>{html_escape(title)}</b>",
        "",
        f"💰 Баланс: <b>{now['totalUsd']:.0f} USD</b>, з них готівка <b>{now['cashUsd']:.0f} USD</b>",
        f"{day_emoji} За день: {day_text}",
        "",
        "🧩 <b>Склад</b>",
        *composition_lines(holdings, now.get("cashUsd") or 0, now.get("totalUsd") or 0),
        "",
        "📋 <b>Позиції:</b>",
    ]
    rendered = [position_line(item, usd_per_eur) for item in holdings]
    lines.append(("\n" + ("-" * 34) + "\n").join(rendered))
    return "\n".join(lines)


def maybe_notify(conn, latest):
    today = datetime.now().astimezone().date().isoformat()
    hour = datetime.now().astimezone().hour
    report_hour = int(load_secrets().get("portfolio_report_hour") or REPORT_HOUR)
    if hour == report_hour and meta_get(conn, "last_report_date") != today:
        send_telegram(format_report(latest, "Аналітика за день"))
        meta_set(conn, "last_report_date", today)
        conn.commit()
    change = latest["latest"].get("dayChangePct")
    threshold = float(load_secrets().get("portfolio_alert_pct") or ALERT_PCT)
    if change is not None and abs(change) >= threshold and meta_get(conn, "last_alert_date") != today:
        send_telegram(format_report(latest, f"Портфель зрушив на {change:+.1f}%"))
        meta_set(conn, "last_alert_date", today)
        conn.commit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--hourly", action="store_true")
    parser.add_argument("--print-total", action="store_true")
    parser.add_argument("--sync-b64")
    parser.add_argument("--sync-file")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    conn = connect()
    if args.print_total:
        latest = read_portfolio()
        print(0 if latest is None else latest.get("latest", {}).get("totalUsd") or 0)
        return
    if args.sync_b64 == "report" or args.report:
        log("запит звіту в Telegram")
        try:
            latest = read_portfolio()
            if latest is None:
                publish(conn)
                latest = read_portfolio()
            if latest is None:
                raise RuntimeError("немає збереженого портфеля")
            sent = send_telegram(format_report(latest, "Аналітика за день"))
        except Exception as error:
            log(f"звіт не надіслано: {error}")
            write_report_status(False, str(error))
            raise SystemExit(1)
        write_report_status(sent, "надіслано" if sent else "Telegram не налаштований")
        log("звіт надіслано" if sent else "звіт не надіслано: Telegram не налаштований")
        if not sent:
            raise SystemExit(1)
        return
    if args.sync_b64 or args.sync_file:
        if args.sync_file:
            with open(args.sync_file, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
        else:
            payload = json.loads(base64.b64decode(args.sync_b64).decode("utf-8"))
        import_snapshot(conn, payload)
        log(f"синхронізовано позицій: {len(payload.get('positions') or [])}")
        total = mark_to_market(conn)
        print(f"{total:.2f}")
        return
    total = mark_to_market(conn)
    print(f"{total:.2f}")


if __name__ == "__main__":
    main()

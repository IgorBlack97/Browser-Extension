#!/usr/bin/env python3
"""Окремий збирач вартості портфеля для Home Assistant.

Плагін IBKR надсилає склад рахунку. Цей скрипт раз на годину бере ціни
з Yahoo Finance, переводить їх у долари курсом ЄЦБ і пише історію.
З курсом P2P він не пов'язаний.
"""

import argparse
import base64
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
JSON_PATH = os.environ.get("PORTFOLIO_JSON_PATH", os.path.join(WWW_DIR, "portfolio.json"))
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


def yahoo_quote(symbol):
    encoded = urllib.parse.quote(symbol)
    data = fetch_json(f"https://query1.finance.yahoo.com/v8/finance/chart/{encoded}?interval=1d&range=5d")
    result = (data.get("chart") or {}).get("result") or []
    if not result:
        raise RuntimeError(f"Yahoo без даних для {symbol}")
    meta = result[0].get("meta") or {}
    price = meta.get("regularMarketPrice")
    if price is None:
        raise RuntimeError(f"Yahoo без ціни для {symbol}")
    previous = meta.get("chartPreviousClose") or meta.get("previousClose")
    change = None
    if previous:
        change = (float(price) - float(previous)) / float(previous) * 100
    return {
        "symbol": meta.get("symbol") or symbol,
        "price": float(price),
        "currency": (meta.get("currency") or "").upper(),
        "dayChangePct": change,
    }


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


def import_snapshot(conn, payload):
    now = datetime.now().astimezone().isoformat(timespec="seconds")
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
    os.makedirs(os.path.dirname(JSON_PATH), exist_ok=True)
    with open(JSON_PATH, "w", encoding="utf-8") as handle:
        json.dump(latest, handle, ensure_ascii=False, indent=2)
    copy_dashboard()
    log(f"записано {JSON_PATH}")


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


def send_telegram(text):
    secrets = load_secrets()
    token = os.environ.get("PORTFOLIO_TG_BOT_TOKEN") or secrets.get("portfolio_tg_bot_token")
    chat = os.environ.get("PORTFOLIO_TG_CHAT_ID") or secrets.get("portfolio_tg_chat_id")
    if not token or not chat:
        log("Telegram для портфеля не налаштований")
        return
    body = json.dumps({"chat_id": chat, "text": text}).encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=20):
        return


def format_report(latest, title):
    now = latest["latest"]
    day = now.get("dayChangePct")
    day_text = "ще немає вчорашньої точки" if day is None else f"{day:+.2f}% ({now['dayChangeUsd']:+.0f} USD)"
    lines = [
        title,
        f"Разом {now['totalUsd']:.0f} USD, з них готівка {now['cashUsd']:.0f}",
        f"За день: {day_text}",
    ]
    movers = sorted(latest["holdings"], key=lambda item: item.get("valueUsd") or 0, reverse=True)[:5]
    for item in movers:
        lines.append(f"{item['ticker']} {item.get('valueUsd') or 0:.0f} USD")
    return "\n".join(lines)


def maybe_notify(conn, latest):
    today = datetime.now().astimezone().date().isoformat()
    hour = datetime.now().astimezone().hour
    report_hour = int(load_secrets().get("portfolio_report_hour") or REPORT_HOUR)
    if hour == report_hour and meta_get(conn, "last_report_date") != today:
        send_telegram(format_report(latest, "Портфель за день"))
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
        if os.path.isfile(JSON_PATH):
            with open(JSON_PATH, "r", encoding="utf-8") as handle:
                latest = json.load(handle)
            print(latest.get("latest", {}).get("totalUsd") or 0)
        else:
            print("0")
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
    if args.report:
        publish(conn)
        with open(JSON_PATH, "r", encoding="utf-8") as handle:
            latest = json.load(handle)
        send_telegram(format_report(latest, "Портфель"))
        return
    total = mark_to_market(conn)
    print(f"{total:.2f}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Binance P2P Rate Collector для Home Assistant (USDT / UAH)
==========================================================
Як працює:
1. Робить публічний POST-запит до Binance P2P (/bapi/c2c/v2/friendly/c2c/adv/search)
   для USDT/UAH (PrivatBank + Monobank), ігноруючи рекламні оголошення (Promoted Ad)
   та дрібні ордери (< min_limit_uah) і відсікаючи помилкові простріли ціни (>1.5% нижче медіани ТОП-5).
2. Агрегує найнижчу ціну всередині кожного 5-хвилинного вікна (bucketTs).
3. Зберігає історію одночасно:
   - у SQLite базу (/config/p2p_history.db) — надійна база даних на диску;
   - у публічний JSON (/config/www/p2p-history.json) — щоб браузерний плагін
     міг миттєво читати всю історію за адресою:
     https://ha.ibtek.uk/local/p2p-history.json або http://homeassistant.local:8123/local/p2p-history.json

Режими запуску:
- Разовий замір (ідеально для command_line sensor у Home Assistant кожні 15 сек):
    python3 /config/p2p_collector.py --once
- Постійний фоновий демон (якщо запускати окремим процесом):
    python3 /config/p2p_collector.py --daemon --interval 15
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import urllib.request
from datetime import datetime, timezone

# ================= НАЛАШТУВАННЯ ЗА ЗАМОВЧУВАННЯМ =================
# Скрипт та база даних лежать у /homeassistant/P2P_monitoring (SCRIPT_DIR),
# а secrets.yaml та папка www лежать на рівень вище — у корені Home Assistant (HA_ROOT_DIR).
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(SCRIPT_DIR)

if os.path.exists(os.path.join(SCRIPT_DIR, "configuration.yaml")):
    HA_ROOT_DIR = SCRIPT_DIR
elif os.path.exists(os.path.join(PARENT_DIR, "configuration.yaml")):
    HA_ROOT_DIR = PARENT_DIR
elif os.path.isdir("/config"):
    HA_ROOT_DIR = "/config"
elif os.path.isdir("/homeassistant"):
    HA_ROOT_DIR = "/homeassistant"
else:
    HA_ROOT_DIR = SCRIPT_DIR

# База даних зберігається прямо в папці P2P_monitoring поруч зі скриптом
DB_PATH = os.environ.get("P2P_DB_PATH", os.path.join(SCRIPT_DIR, "p2p_history.db"))
# Публічний JSON зберігається у /homeassistant/www/p2p-history.json (для доступу через /local/p2p-history.json)
WWW_DIR = os.path.join(HA_ROOT_DIR, "www")
JSON_OUT_PATH = os.environ.get("P2P_JSON_PATH", os.path.join(WWW_DIR, "p2p-history.json"))
# Ключі Telegram читаються з /homeassistant/secrets.yaml (або P2P_monitoring/secrets.yaml)
SECRETS_PATH = (
    os.path.join(SCRIPT_DIR, "secrets.yaml")
    if os.path.isfile(os.path.join(SCRIPT_DIR, "secrets.yaml"))
    else os.path.join(HA_ROOT_DIR, "secrets.yaml")
)

MIN_ORDER_LIMIT_UAH = float(os.environ.get("P2P_MIN_LIMIT_UAH", "500"))
DAILY_REPORT_HOUR = int(os.environ.get("P2P_DAILY_REPORT_HOUR", "21"))  # 21:00 за локальним часом сервера HA
PAY_TYPES = ["PrivatBank", "Monobank"]
MAX_HISTORY_BUCKETS = 25000  # ~85 днів 5-хвилинних записів

BINANCE_ENDPOINTS = [
    "https://c2c.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
    "https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
    "https://www.binance.com/bapi/c2c/v2/friendly/c2c/adv/search",
]


def get_five_min_bucket(ts_ms: int) -> int:
    five_min_ms = 5 * 60 * 1000
    return (ts_ms // five_min_ms) * five_min_ms


def init_db(conn: sqlite3.Connection):
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS rate_history (
            bucketTs INTEGER PRIMARY KEY,
            minAtTs INTEGER,
            lastCheckTs INTEGER,
            minPrice REAL,
            maxPriceInBucket REAL,
            lastPrice REAL,
            top5Avg REAL,
            merchant TEXT,
            minLimit REAL,
            maxLimit REAL,
            banks TEXT,
            samples INTEGER
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tracker_meta (
            key TEXT PRIMARY KEY,
            value TEXT
        )
        """
    )
    conn.commit()
    import_existing_json_if_present(conn)


def import_existing_json_if_present(conn: sqlite3.Connection):
    """
    Якщо у /homeassistant/www/p2p-history.json (або поруч зі скриптом) вже лежить
    перенесений з ПК файл історії — автоматично імпортує всі записи в SQLite базу (INSERT OR IGNORE),
    щоб продовжити збір без втрати старих даних!
    """
    candidate_paths = [
        os.path.join(SCRIPT_DIR, "p2p-history.json"),
        JSON_OUT_PATH,
        os.path.join(HA_ROOT_DIR, "p2p-history.json"),
    ]
    for path in candidate_paths:
        if not os.path.isfile(path):
            continue
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            records = data.get("records") if isinstance(data, dict) else (data if isinstance(data, list) else [])
            if not records:
                continue

            cur = conn.cursor()
            for r in records:
                bucket_ts = r.get("bucketTs")
                min_price = r.get("minPrice")
                if not bucket_ts or min_price is None:
                    continue
                cur.execute(
                    """
                    INSERT OR IGNORE INTO rate_history (
                        bucketTs, minAtTs, lastCheckTs, minPrice, maxPriceInBucket, lastPrice,
                        top5Avg, merchant, minLimit, maxLimit, banks, samples
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        int(bucket_ts),
                        int(r.get("minAtTs") or bucket_ts),
                        int(r.get("lastCheckTs") or bucket_ts),
                        float(min_price),
                        float(r.get("maxPriceInBucket") or min_price),
                        float(r.get("lastPrice") or min_price),
                        float(r.get("top5Avg") or min_price),
                        str(r.get("merchant") or "Unknown"),
                        float(r.get("minLimit") or 0),
                        float(r.get("maxLimit") or 0),
                        str(r.get("banks") or ""),
                        int(r.get("samples") or 1),
                    ),
                )
            conn.commit()
        except Exception:
            pass


def fetch_best_p2p_offers(min_limit_uah: float = MIN_ORDER_LIMIT_UAH):
    payload = {
        "fiat": "UAH",
        "page": 1,
        "rows": 20,
        "tradeType": "BUY",
        "asset": "USDT",
        "countries": [],
        "proMerchantAds": False,
        "shieldMerchantAds": False,
        "filterType": "tradable",
        "periods": [],
        "additionalKycVerifyFilter": 0,
        "publisherType": None,
        "payTypes": PAY_TYPES,
        "classifies": ["mass", "profession", "fiat_trade"],
    }
    body_bytes = json.dumps(payload).encode("utf-8")

    data = None
    for url in BINANCE_ENDPOINTS:
        try:
            req = urllib.request.Request(
                url,
                data=body_bytes,
                headers={
                    "Content-Type": "application/json",
                    "Cache-Control": "no-cache",
                    "User-Agent": "Mozilla/5.0 (compatible; HomeAssistant-P2PTracker/1.0)",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                if resp.status == 200:
                    data = json.loads(resp.read().decode("utf-8"))
                    break
        except Exception:
            continue

    if not data or not isinstance(data.get("data"), list):
        return []

    valid_offers = []
    for item in data["data"]:
        # Пропускаємо Promoted Ad
        if item.get("privilegeDesc"):
            continue
        adv = item.get("adv") or {}
        advertiser = item.get("advertiser") or {}
        try:
            price = float(adv.get("price"))
            min_limit = float(adv.get("minSingleTransAmount"))
            max_limit = float(adv.get("dynamicMaxSingleTransAmount") or adv.get("maxSingleTransAmount"))
            available_usdt = float(adv.get("surplusAmount") or 0)
        except (TypeError, ValueError):
            continue

        if min_limit_uah and max_limit < min_limit_uah:
            continue

        trade_methods = adv.get("tradeMethods") or []
        banks = ", ".join(
            str(m.get("tradeMethodName") or m.get("identifier") or "")
            for m in trade_methods
            if m.get("tradeMethodName") or m.get("identifier")
        )

        valid_offers.append(
            {
                "price": price,
                "minLimit": min_limit,
                "maxLimit": max_limit,
                "availableUSDT": available_usdt,
                "merchant": advertiser.get("nickName") or "Unknown",
                "banks": banks,
            }
        )

    valid_offers.sort(key=lambda x: x["price"])

    # Відсікаємо помилкові/фейкові простріли (більше ніж на 1.5% нижче медіани 2..6 місця)
    if len(valid_offers) >= 4:
        ref_slice = [o["price"] for o in valid_offers[1 : min(6, len(valid_offers))]]
        ref_slice.sort()
        ref_median = ref_slice[len(ref_slice) // 2]
        max_drop = ref_median * 0.015
        valid_offers = [o for o in valid_offers if (ref_median - o["price"]) <= max_drop]

    return valid_offers


def export_json_snapshot(conn: sqlite3.Connection, last_sample: dict):
    os.makedirs(os.path.dirname(JSON_OUT_PATH), exist_ok=True)
    cur = conn.cursor()
    cur.execute(
        """
        SELECT bucketTs, minAtTs, lastCheckTs, minPrice, maxPriceInBucket, lastPrice,
               top5Avg, merchant, minLimit, maxLimit, banks, samples
        FROM rate_history
        ORDER BY bucketTs ASC
        """
    )
    rows = cur.fetchall()
    records = [
        {
            "bucketTs": r[0],
            "minAtTs": r[1],
            "lastCheckTs": r[2],
            "minPrice": r[3],
            "maxPriceInBucket": r[4],
            "lastPrice": r[5],
            "top5Avg": r[6],
            "merchant": r[7],
            "minLimit": r[8],
            "maxLimit": r[9],
            "banks": r[10],
            "samples": r[11],
        }
        for r in rows
    ]

    snapshot = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "totalBuckets": len(records),
        "lastSample": last_sample,
        "records": records,
    }

    tmp_path = JSON_OUT_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(snapshot, f, ensure_ascii=False)
    os.replace(tmp_path, JSON_OUT_PATH)
    return records


def load_telegram_credentials():
    """
    Читає p2p_tg_bot_token та p2p_tg_chat_id із /homeassistant/secrets.yaml
    (або зі змінних оточення P2P_TG_BOT_TOKEN / P2P_TG_CHAT_ID).
    """
    bot_token = os.environ.get("P2P_TG_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("P2P_TG_CHAT_ID", "").strip()

    if (not bot_token or not chat_id) and os.path.isfile(SECRETS_PATH):
        try:
            with open(SECRETS_PATH, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    m_tok = re.match(r'^p2p_tg_bot_token\s*:\s*["\']?([^"\'#\s]+)["\']?', line)
                    if m_tok:
                        bot_token = m_tok.group(1).strip()
                    m_chat = re.match(r'^p2p_tg_chat_id\s*:\s*["\']?([^"\'#\s]+)["\']?', line)
                    if m_chat:
                        chat_id = m_chat.group(1).strip()
        except Exception:
            pass

    return bot_token, chat_id


def get_median_value(vals):
    if not vals:
        return 0.0
    s = sorted(vals)
    mid = len(s) // 2
    return float(s[mid]) if len(s) % 2 == 1 else (s[mid - 1] + s[mid]) / 2.0


def filter_outliers_from_records(raw_list):
    if not raw_list:
        return []
    cleaned = []
    for idx, item in enumerate(raw_list):
        price = float(item["minPrice"])
        top5_avg = float(item.get("top5Avg") or price)
        if top5_avg and (top5_avg - price) > 0.55:
            price = round(top5_avg - 0.12, 2)

        start = max(0, idx - 6)
        end = min(len(raw_list) - 1, idx + 6)
        window = []
        for j in range(start, end + 1):
            if j == idx:
                continue
            r_j = raw_list[j]
            p_j = float(r_j["minPrice"])
            t_j = float(r_j.get("top5Avg") or p_j)
            if t_j and (t_j - p_j) > 0.55:
                p_j = t_j - 0.12
            window.append(p_j)

        if len(window) >= 3:
            loc_med = get_median_value(window)
            if (loc_med - price) > 0.50:
                price = round(loc_med, 2)

        new_item = dict(item)
        new_item["minPrice"] = price
        cleaned.append(new_item)
    return cleaned


def send_daily_telegram_summary(records, force_manual=False):
    bot_token, chat_id = load_telegram_credentials()
    if not bot_token or not chat_id:
        sys.stderr.write(
            f"[p2p_collector] Не знайдено p2p_tg_bot_token або p2p_tg_chat_id у {SECRETS_PATH}\n"
        )
        return False

    clean_records = filter_outliers_from_records(records)
    cutoff_ms = int((time.time() - 24 * 3600) * 1000)
    last_24h = [r for r in clean_records if r["bucketTs"] >= cutoff_ms]
    dataset = last_24h if last_24h else clean_records
    if not dataset:
        sys.stderr.write("[p2p_collector] База даних порожня (0 записів)\n")
        return False

    min_item = min(dataset, key=lambda x: x["minPrice"])
    max_item = max(dataset, key=lambda x: x["minPrice"])
    avg_24h = sum(x["minPrice"] for x in dataset) / len(dataset)

    by_hour = {h: [] for h in range(24)}
    for item in dataset:
        dt = datetime.fromtimestamp(item["bucketTs"] / 1000.0)
        by_hour[dt.hour].append(item["minPrice"])

    hour_ranking = []
    for h, prices in by_hour.items():
        if not prices:
            continue
        hour_ranking.append(
            {
                "hour": h,
                "avg": sum(prices) / len(prices),
                "min": min(prices),
                "count": len(prices),
            }
        )
    hour_ranking.sort(key=lambda x: x["avg"])

    medals = ["🥇", "🥈", "🥉"]
    top3_lines = [
        f"  {medals[i]} <b>{h['hour']:02d}:00–{h['hour']:02d}:59</b> — сер. <b>{h['avg']:.2f} ₴</b> (мін: {h['min']:.2f} ₴)"
        for i, h in enumerate(hour_ranking[:3])
    ]
    worst3_lines = [
        f"  🔺 #{i + 1} <b>{h['hour']:02d}:00–{h['hour']:02d}:59</b> — сер. <b>{h['avg']:.2f} ₴</b>"
        for i, h in enumerate(reversed(hour_ranking[-3:]))
    ]

    min_time_str = datetime.fromtimestamp(min_item["bucketTs"] / 1000.0).strftime("%H:%M")
    max_time_str = datetime.fromtimestamp(max_item["bucketTs"] / 1000.0).strftime("%H:%M")
    latest = dataset[-1]

    title = (
        "📊 <b>Об’єктивне зведення P2P USDT/UAH (Home Assistant)</b>"
        if force_manual
        else "📊 <b>Щоденне зведення курсу P2P USDT/UAH (Home Assistant, за 24 год)</b>"
    )

    text = "\n".join(
        [
            title,
            "",
            f"💵 Поточний курс: <b>{latest['minPrice']:.2f} UAH</b> ({latest['merchant']})",
            f"📉 Реальний мінімум за добу: <b>{min_item['minPrice']:.2f} UAH</b> (о {min_time_str}, {min_item['merchant']})",
            f"📈 Максимум за добу: <b>{max_item['minPrice']:.2f} UAH</b> (о {max_time_str})",
            f"⚖️ Середній курс: <b>{avg_24h:.2f} UAH</b>",
            f"📏 Реальний розкид: <b>{(max_item['minPrice'] - min_item['minPrice']):.2f} UAH</b>",
            "",
            "🟢 <b>ТОП-3 найвигідніші години для купівлі:</b>",
            "\n".join(top3_lines) if top3_lines else "  Недостатньо даних",
            "",
            "🔴 <b>ТОП-3 найдорожчі години:</b>",
            "\n".join(worst3_lines) if worst3_lines else "  Недостатньо даних",
            "",
            f"🗂 Всього 5-хвилинних замірів за добу: <b>{len(dataset)}</b>",
        ]
    )

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = json.dumps(
        {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
    ).encode("utf-8")
    try:
        req = urllib.request.Request(
            url,
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception as e:
        sys.stderr.write(f"[p2p_collector] Telegram error: {e}\n")
        return False


def check_and_send_daily_report(conn: sqlite3.Connection, records: list):
    now = datetime.now()
    if now.hour != DAILY_REPORT_HOUR:
        return

    today_key = now.strftime("%Y-%m-%d")
    cur = conn.cursor()
    cur.execute("SELECT value FROM tracker_meta WHERE key = 'last_daily_report_date'")
    row = cur.fetchone()
    if row and row[0] == today_key:
        return

    if len(records) < 3:
        return

    if send_daily_telegram_summary(records, force_manual=False):
        cur.execute(
            "INSERT OR REPLACE INTO tracker_meta (key, value) VALUES ('last_daily_report_date', ?)",
            (today_key,),
        )
        conn.commit()


def collect_once(min_limit_uah: float = MIN_ORDER_LIMIT_UAH):
    offers = fetch_best_p2p_offers(min_limit_uah)
    if not offers:
        return None

    best = offers[0]
    top5 = offers[: min(5, len(offers))]
    top5_avg = round(sum(o["price"] for o in top5) / len(top5), 2)

    now_ms = int(time.time() * 1000)
    bucket_ts = get_five_min_bucket(now_ms)

    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    try:
        init_db(conn)
        cur = conn.cursor()
        cur.execute(
            "SELECT minPrice, maxPriceInBucket, samples FROM rate_history WHERE bucketTs = ?",
            (bucket_ts,),
        )
        existing = cur.fetchone()

        if existing is None:
            cur.execute(
                """
                INSERT INTO rate_history (
                    bucketTs, minAtTs, lastCheckTs, minPrice, maxPriceInBucket, lastPrice,
                    top5Avg, merchant, minLimit, maxLimit, banks, samples
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
                """,
                (
                    bucket_ts,
                    now_ms,
                    now_ms,
                    best["price"],
                    best["price"],
                    best["price"],
                    top5_avg,
                    best["merchant"],
                    best["minLimit"],
                    best["maxLimit"],
                    best["banks"],
                ),
            )
        else:
            prev_min, prev_max, prev_samples = existing
            samples = (prev_samples or 1) + 1
            new_max = max(prev_max or best["price"], best["price"])

            if best["price"] < prev_min:
                cur.execute(
                    """
                    UPDATE rate_history
                    SET minAtTs = ?, lastCheckTs = ?, minPrice = ?, maxPriceInBucket = ?,
                        lastPrice = ?, top5Avg = ?, merchant = ?, minLimit = ?, maxLimit = ?,
                        banks = ?, samples = ?
                    WHERE bucketTs = ?
                    """,
                    (
                        now_ms,
                        now_ms,
                        best["price"],
                        new_max,
                        best["price"],
                        top5_avg,
                        best["merchant"],
                        best["minLimit"],
                        best["maxLimit"],
                        best["banks"],
                        samples,
                        bucket_ts,
                    ),
                )
            else:
                cur.execute(
                    """
                    UPDATE rate_history
                    SET lastCheckTs = ?, maxPriceInBucket = ?, lastPrice = ?, top5Avg = ?, samples = ?
                    WHERE bucketTs = ?
                    """,
                    (now_ms, new_max, best["price"], top5_avg, samples, bucket_ts),
                )

        # Обмежуємо розмір таблиці до MAX_HISTORY_BUCKETS
        cur.execute(
            """
            DELETE FROM rate_history
            WHERE bucketTs NOT IN (
                SELECT bucketTs FROM rate_history ORDER BY bucketTs DESC LIMIT ?
            )
            """,
            (MAX_HISTORY_BUCKETS,),
        )
        conn.commit()

        last_sample = {
            "ts": now_ms,
            "best": best,
            "top5Avg": top5_avg,
        }
        records = export_json_snapshot(conn, last_sample)
        check_and_send_daily_report(conn, records)
        return last_sample
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="Binance P2P Rate Collector for Home Assistant")
    parser.add_argument("--once", action="store_true", help="Виконати один замір і вийти (для command_line sensor HA)")
    parser.add_argument("--send-report", action="store_true", help="Примусово надіслати зведення в Telegram зараз")
    parser.add_argument("--daemon", action="store_true", help="Працювати у нескінченному циклі")
    parser.add_argument("--interval", type=int, default=15, help="Інтервал опитування в секундах (для --daemon)")
    parser.add_argument("--min-limit", type=float, default=MIN_ORDER_LIMIT_UAH, help="Мінімальний верхній ліміт ордера (грн)")
    args = parser.parse_args()

    if args.send_report:
        conn = sqlite3.connect(DB_PATH, timeout=10)
        init_db(conn)
        records = export_json_snapshot(conn, None)
        ok = send_daily_telegram_summary(records, force_manual=True)
        conn.close()
        print("report_sent" if ok else "report_failed")
        return

    if args.daemon:
        while True:
            try:
                collect_once(args.min_limit)
            except Exception as e:
                sys.stderr.write(f"[p2p_collector] Error: {e}\n")
            time.sleep(max(3, args.interval))
    else:
        sample = collect_once(args.min_limit)
        if sample and sample.get("best"):
            # Виводимо поточну ціну в stdout, щоб command_line sensor у Home Assistant міг читати її як стан сенсора
            print(f"{sample['best']['price']:.2f}")
        else:
            print("unavailable")


if __name__ == "__main__":
    main()

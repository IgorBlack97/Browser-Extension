# Binance P2P Browser Extensions

У цьому репозиторії знаходяться 3 розширення для роботи з Binance P2P (USDT/UAH):

1. **`p2p-autobuy-bot/`** — **Бойовий бот для автопокупки (`🤖 Binance P2P Fast Auto-Buy Bot`)**
   Автоматичний пошук і викуп ордерів USDT/UAH (PrivatBank / Monobank) за заданою ціною та діапазоном суми + демо-режим і миттєві сповіщення в Telegram.

2. **`p2p-tracker-extension/`** — **Локальний трекер курсу (`📈 Binance P2P Rate Tracker`)**
   Фоновий збір найнижчого курсу кожні 5 хвилин безпосередньо у браузері + дашборд аналітики по годинах і днях.

3. **`p2p-ha-tracker/`** — **Серверний трекер курсу 24/7 для Home Assistant (`🏠 Binance P2P Remote Tracker`)**
   - `ha-server/p2p_collector.py` — Python-скрипт для Home Assistant, який 24/7 збирає курс у SQLite та JSON і надсилає щоденне зведення о 21:00 у Telegram.
   - `browser-extension/` — браузерний плагін, який читає зібрану базу з Home Assistant (`https://ha.ibtek.uk/local/p2p-history.json`) і будує графіки.

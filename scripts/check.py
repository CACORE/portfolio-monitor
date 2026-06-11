"""
每日再平衡檢查 — 台股開盤後自動執行
持倉資料由網頁自動同步至 portfolio-data.json，無需手動更新
"""

import json
import os
import sys
import requests
from datetime import date, timedelta, datetime
from pathlib import Path


# ===== Telegram（從 GitHub Actions Secrets 注入，不寫死在程式碼）=====
TG_TOKEN   = os.environ.get('TG_TOKEN', '')
TG_CHAT_ID = os.environ.get('TG_CHAT_ID', '')

if not TG_TOKEN or not TG_CHAT_ID:
    sys.exit('缺少 TG_TOKEN / TG_CHAT_ID 環境變數，請在 repo Settings → Secrets 設定')


def load_portfolio():
    """從 portfolio-data.json 讀取持倉，找不到時回傳 None"""
    p = Path(__file__).parent.parent / 'portfolio-data.json'
    if not p.exists():
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def get_asset(data, symbol):
    return next((a for a in data['assets'] if a['symbol'] == symbol), None)


def get_price(symbol_tw):
    try:
        r = requests.get(
            f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol_tw}?interval=1d&range=1d',
            headers={'User-Agent': 'Mozilla/5.0'},
            timeout=10,
        )
        return r.json()['chart']['result'][0]['meta']['regularMarketPrice']
    except Exception:
        return None


def send_telegram(text):
    try:
        requests.post(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            json={'chat_id': TG_CHAT_ID, 'text': text, 'parse_mode': 'HTML'},
            timeout=10,
        )
    except Exception:
        pass


def quarter_first_trading_day(year, month):
    d = date(year, month, 1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def is_today_quarter_open():
    today = date.today()
    if today.month not in (1, 4, 7, 10):
        return False
    return today == quarter_first_trading_day(today.year, today.month)


def main():
    data = load_portfolio()
    if data is None:
        send_telegram('⚠️ 投資牛馬｜portfolio-data.json 不存在，請先在網頁⚙設定 GitHub Token')
        return

    tw631_asset = get_asset(data, '00631L')
    cash_asset  = get_asset(data, 'CASH')

    if not tw631_asset or not cash_asset:
        send_telegram('⚠️ 投資牛馬｜找不到 00631L 或 CASH 資產，請確認網頁資料')
        return

    price = get_price('00631L.TW')
    if price is None:
        send_telegram('⚠️ 投資牛馬｜00631L 價格抓取失敗，請手動確認')
        return

    tw631_qty = float(tw631_asset['qty'])
    cash_twd  = float(cash_asset['qty'])
    usd_rate  = float(data.get('usdRate', 32.5))

    tw631_val = tw631_qty * price
    cash_val  = cash_twd
    tw_total  = tw631_val + cash_val
    ratio     = tw631_val / tw_total
    diff      = tw_total * 0.5 - tw631_val
    now_str   = datetime.now().strftime('%Y/%m/%d %H:%M')

    updated_at = data.get('updatedAt', '未知')[:16].replace('T', ' ')

    # 70/30 危險區警示
    if ratio > 0.70 or ratio < 0.30:
        side   = '00631L 持倉過多' if ratio > 0.70 else '現金比例過高'
        action = '▼ 建議賣出 00631L' if ratio > 0.70 else '▲ 建議買進 00631L'
        send_telegram(
            f'<b>🚨 投資牛馬｜再平衡警示</b>\n\n'
            f'台股比例：<b>{ratio*100:.1f}% / {(1-ratio)*100:.1f}%</b>\n'
            f'狀態：{side}（70/30 危險區）\n\n'
            f'{action} <b>NT${abs(diff):,.0f}</b>\n\n'
            f'00631L {tw631_qty:g} 股 × {price:.2f} = NT${tw631_val:,.0f}\n'
            f'現金：NT${cash_val:,.0f}\n'
            f'持倉更新：{updated_at}　📅 {now_str}'
        )

    # 季度第一個交易日提醒
    if is_today_quarter_open():
        q      = (date.today().month - 1) // 3 + 1
        status = '⚠️ 已偏離' if abs(ratio - 0.5) > 0.05 else '✓ 接近平衡'
        send_telegram(
            f'<b>📅 投資牛馬｜Q{q} 季度再平衡提醒</b>\n\n'
            f'今天是本季第一個交易日，記得檢視再平衡！\n\n'
            f'目前比例：<b>{ratio*100:.1f}% / {(1-ratio)*100:.1f}%</b>　{status}\n'
            f'00631L 市值：NT${tw631_val:,.0f}\n'
            f'現金備用：NT${cash_val:,.0f}\n'
            f'持倉更新：{updated_at}　📅 {now_str}'
        )


if __name__ == '__main__':
    main()

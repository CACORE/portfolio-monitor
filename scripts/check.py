"""
每日再平衡檢查 — 台股開盤後自動執行
更新持倉時修改下方 PORTFOLIO 設定
"""

import requests
from datetime import date, timedelta, datetime

# ===== Telegram =====
TG_TOKEN   = '8209054446:AAF3MXVYTjS7aviPBVQaxruKo93rVOSeD6c'
TG_CHAT_ID = '7341232461'

# ===== 持倉設定（UI 改動後請同步更新） =====
TW631_QTY = 5000    # 00631L 持股張數（股）
CASH_TWD  = 300000  # 台股備用現金（台幣）


def get_price(symbol_tw):
    """Yahoo Finance 抓台股價格，伺服器端無 CORS 限制"""
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
    """取得該月第一個交易日（週一到週五）"""
    d = date(year, month, 1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def is_today_quarter_open():
    """今天是否為某季第一個交易日"""
    today = date.today()
    if today.month not in (1, 4, 7, 10):
        return False
    return today == quarter_first_trading_day(today.year, today.month)


def main():
    price = get_price('00631L.TW')
    if price is None:
        send_telegram('⚠️ 投資牛馬｜00631L 價格抓取失敗，請手動確認')
        return

    tw631_val = TW631_QTY * price
    cash_val  = CASH_TWD
    tw_total  = tw631_val + cash_val
    ratio     = tw631_val / tw_total
    diff      = tw_total * 0.5 - tw631_val
    now_str   = datetime.now().strftime('%Y/%m/%d %H:%M')

    # 70/30 危險區警示
    if ratio > 0.70 or ratio < 0.30:
        side   = '00631L 持倉過多' if ratio > 0.70 else '現金比例過高'
        action = '▼ 建議賣出 00631L' if ratio > 0.70 else '▲ 建議買進 00631L'
        send_telegram(
            f'<b>🚨 投資牛馬｜再平衡警示</b>\n\n'
            f'台股比例：<b>{ratio*100:.1f}% / {(1-ratio)*100:.1f}%</b>\n'
            f'狀態：{side}（已觸發 70/30 危險區）\n\n'
            f'{action} <b>NT${abs(diff):,.0f}</b>\n\n'
            f'00631L：NT${tw631_val:,.0f}　現金：NT${cash_val:,.0f}\n'
            f'📅 {now_str}'
        )

    # 季度第一個交易日提醒
    if is_today_quarter_open():
        q = (date.today().month - 1) // 3 + 1
        status = '⚠️ 已偏離' if abs(ratio - 0.5) > 0.05 else '✓ 接近平衡'
        send_telegram(
            f'<b>📅 投資牛馬｜Q{q} 季度再平衡提醒</b>\n\n'
            f'今天是本季第一個交易日，記得檢視再平衡！\n\n'
            f'目前比例：<b>{ratio*100:.1f}% / {(1-ratio)*100:.1f}%</b>　{status}\n'
            f'00631L 市值：NT${tw631_val:,.0f}\n'
            f'現金備用：NT${cash_val:,.0f}\n\n'
            f'📅 {now_str}'
        )


if __name__ == '__main__':
    main()

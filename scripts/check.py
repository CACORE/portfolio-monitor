"""
每日曝險檢查 — 台股開盤後自動執行
持倉資料由網頁自動同步至 portfolio-data.json，無需手動更新

曝險邏輯：
  - 加密貨幣、台股、美股等風險資產計入曝險（× 槓桿倍數）
  - 正2 ETF（leverage=2）等效曝險 = 名目市值 × 2
  - cash / lending 板塊視為現金，不計曝險
  - 等效曝險 / 總資產 > 70% → 警示
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

SAFE_CATEGORIES = {'cash', 'lending'}


def load_portfolio():
    p = Path(__file__).parent.parent / 'portfolio-data.json'
    if not p.exists():
        return None
    with open(p, encoding='utf-8') as f:
        return json.load(f)


def get_usd_rate():
    """抓取即時 USD/TWD 匯率"""
    try:
        r = requests.get('https://open.er-api.com/v6/latest/USD', timeout=10).json()
        if r.get('rates', {}).get('TWD'):
            return float(r['rates']['TWD'])
    except Exception:
        pass
    return 31.5  # fallback


def get_price_twd(asset, usd_rate):
    """取得資產台幣單價（fixed 類型直接換算）"""
    src = asset.get('priceSource', 'fixed')
    symbol = asset['symbol']
    currency = asset.get('currency', 'TWD')

    if src == 'fixed':
        return usd_rate if currency == 'USD' else 1.0

    try:
        if src == 'binance':
            r = requests.get(
                f'https://api.binance.com/api/v3/ticker/price?symbol={symbol}USDT',
                timeout=10
            ).json()
            return float(r['price']) * usd_rate

        if src == 'bitget':
            r = requests.get(
                f'https://api.bitget.com/api/v2/spot/market/tickers?symbol={symbol}USDT',
                timeout=10
            ).json()
            return float(r['data'][0]['lastPr']) * usd_rate

        if src in ('twse', 'us'):
            suffix = '.TW' if src == 'twse' else ''
            r = requests.get(
                f'https://query1.finance.yahoo.com/v8/finance/chart/{symbol}{suffix}?interval=1d&range=1d',
                headers={'User-Agent': 'Mozilla/5.0'},
                timeout=10
            ).json()
            price = r['chart']['result'][0]['meta']['regularMarketPrice']
            return float(price) * (usd_rate if src == 'us' else 1.0)

    except Exception:
        pass
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

    assets = data.get('assets', [])
    if not assets:
        send_telegram('⚠️ 投資牛馬｜找不到資產資料，請確認網頁同步狀態')
        return

    usd_rate = get_usd_rate()
    updated_at = data.get('updatedAt', '未知')[:16].replace('T', ' ')
    now_str = datetime.now().strftime('%Y/%m/%d %H:%M')

    # 計算各資產市值與曝險
    total_assets_twd = 0.0
    total_exposure   = 0.0
    lines = []

    for a in assets:
        price = get_price_twd(a, usd_rate)
        if price is None:
            send_telegram(f"⚠️ 投資牛馬｜{a['symbol']} 價格抓取失敗，請手動確認")
            return

        qty     = float(a.get('qty', 0))
        val     = qty * price
        lev     = float(a.get('leverage', 1))
        cat     = a.get('category', '')
        is_safe = cat in SAFE_CATEGORIES

        total_assets_twd += val
        if not is_safe:
            total_exposure += val * lev

        lev_tag = f' [×{lev:.0f}]' if lev > 1 else ''
        lines.append(
            f"{a['symbol']}{lev_tag}：NT${val:,.0f}"
            + (f'（{cat}）' if is_safe else f'  曝險 NT${val*lev:,.0f}')
        )

    if total_assets_twd <= 0:
        return

    exposure_pct = total_exposure / total_assets_twd
    safe_pct     = 1 - (sum(
        float(a.get('qty', 0)) * (get_price_twd(a, usd_rate) or 0)
        for a in assets if a.get('category', '') not in SAFE_CATEGORIES
    ) / total_assets_twd)

    detail = '\n'.join(lines)

    # 曝險警示（目標 120%，警戒區間如下）
    # > 160%：過高；140–160%：偏高；80–100%：偏低；< 80%：過低
    if exposure_pct > 1.60:
        send_telegram(
            f'<b>🚨 投資牛馬｜曝險過高警示</b>\n\n'
            f'等效曝險：<b>{exposure_pct*100:.1f}%</b>（已超過 160% 警戒線）\n'
            f'目標：120%\n\n'
            f'{detail}\n\n'
            f'持倉更新：{updated_at}　📅 {now_str}'
        )
    elif exposure_pct > 1.40:
        send_telegram(
            f'<b>⚠️ 投資牛馬｜曝險偏高</b>\n\n'
            f'等效曝險：<b>{exposure_pct*100:.1f}%</b>（偏高，目標 120%）\n\n'
            f'{detail}\n\n'
            f'持倉更新：{updated_at}　📅 {now_str}'
        )
    elif exposure_pct < 0.80:
        send_telegram(
            f'<b>▼ 投資牛馬｜曝險過低</b>\n\n'
            f'等效曝險：<b>{exposure_pct*100:.1f}%</b>（低於 80%，目標 120%）\n\n'
            f'{detail}\n\n'
            f'持倉更新：{updated_at}　📅 {now_str}'
        )
    elif exposure_pct < 1.00:
        send_telegram(
            f'<b>▼ 投資牛馬｜曝險偏低</b>\n\n'
            f'等效曝險：<b>{exposure_pct*100:.1f}%</b>（偏低，目標 120%）\n\n'
            f'{detail}\n\n'
            f'持倉更新：{updated_at}　📅 {now_str}'
        )

    # 季度第一個交易日提醒
    if is_today_quarter_open():
        q = (date.today().month - 1) // 3 + 1
        if exposure_pct > 1.40:
            status = '⚠️ 偏高'
        elif exposure_pct >= 1.00:
            status = '✓ 接近目標'
        elif exposure_pct >= 0.80:
            status = '▼ 偏低'
        else:
            status = '▼ 過低'
        send_telegram(
            f'<b>📅 投資牛馬｜Q{q} 季度再平衡提醒</b>\n\n'
            f'今天是本季第一個交易日，記得檢視曝險！\n\n'
            f'等效曝險：<b>{exposure_pct*100:.1f}%</b>　{status}（目標 120%）\n'
            f'總資產：NT${total_assets_twd:,.0f}\n\n'
            f'{detail}\n\n'
            f'持倉更新：{updated_at}　📅 {now_str}'
        )


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Generate a browser-readable TWD quote snapshot for GitHub Pages."""

import argparse
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

USER_AGENT = "portfolio-monitor/1.0"


def fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def market_key(asset):
    return f"{asset['symbol']}.TW" if asset.get("priceSource") == "twse" else asset["symbol"]


def get_usd_rate(portfolio, fixture):
    if fixture and "USD/TWD" in fixture:
        return float(fixture["USD/TWD"])
    try:
        return float(fetch_json("https://open.er-api.com/v6/latest/USD")["rates"]["TWD"])
    except Exception:
        return float(portfolio.get("usdRate", 31.5))


def fetch_market_price(asset, fixture):
    key = market_key(asset)
    if fixture is not None:
        return float(fixture[key])

    source = asset.get("priceSource", "fixed")
    symbol = asset["symbol"]
    if source == "binance":
        result = fetch_json(f"https://api.binance.com/api/v3/ticker/price?symbol={symbol}USDT")
        return float(result["price"])
    if source == "bitget":
        result = fetch_json(f"https://api.bitget.com/api/v2/spot/market/tickers?symbol={symbol}USDT")
        return float(result["data"][0]["lastPr"])
    if source in {"twse", "us"}:
        result = fetch_json(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{key}?interval=1d&range=1d"
        )
        return float(result["chart"]["result"][0]["meta"]["regularMarketPrice"])
    raise ValueError(f"Unsupported price source: {source}")


def build_snapshot(portfolio, fixture=None):
    usd_rate = get_usd_rate(portfolio, fixture)
    prices = {}

    for asset in portfolio.get("assets", []):
        symbol = asset["symbol"]
        source = asset.get("priceSource", "fixed")
        currency = asset.get("currency", "TWD")

        if source == "fixed":
            prices[symbol] = usd_rate if currency == "USD" else 1.0
            continue

        raw_price = fetch_market_price(asset, fixture)
        prices[symbol] = raw_price * usd_rate if currency == "USD" else raw_price

    return {
        "pricesTWD": prices,
        "usdRate": usd_rate,
        "updatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--portfolio", default="portfolio-data.json")
    parser.add_argument("--output", default="quotes.json")
    parser.add_argument("--fixture", help="Optional symbol-to-price JSON fixture")
    args = parser.parse_args()

    portfolio = json.loads(Path(args.portfolio).read_text(encoding="utf-8"))
    fixture = json.loads(Path(args.fixture).read_text(encoding="utf-8")) if args.fixture else None
    snapshot = build_snapshot(portfolio, fixture)
    Path(args.output).write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()

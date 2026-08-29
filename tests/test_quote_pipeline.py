import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP_JS = ROOT / "src" / "App.js"
UPDATE_SCRIPT = ROOT / "scripts" / "update_quotes.py"


class QuotePipelineTests(unittest.TestCase):
    def test_browser_uses_same_origin_quote_snapshot_without_legacy_corsproxy(self):
        source = APP_JS.read_text(encoding="utf-8")
        self.assertIn("./quotes.json", source)
        self.assertNotIn("corsproxy.io", source)

    def run_updater(self, portfolio, fixture, previous=None):
        temp = tempfile.TemporaryDirectory()
        tmp = Path(temp.name)
        portfolio_path = tmp / "portfolio.json"
        fixture_path = tmp / "fixture.json"
        output_path = tmp / "quotes.json"
        portfolio_path.write_text(json.dumps(portfolio), encoding="utf-8")
        fixture_path.write_text(json.dumps(fixture), encoding="utf-8")
        if previous is not None:
            output_path.write_text(json.dumps(previous), encoding="utf-8")
        result = subprocess.run(
            [
                sys.executable,
                str(UPDATE_SCRIPT),
                "--portfolio",
                str(portfolio_path),
                "--output",
                str(output_path),
                "--fixture",
                str(fixture_path),
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        quotes = json.loads(output_path.read_text(encoding="utf-8")) if output_path.exists() else None
        temp.cleanup()
        return result, quotes

    def test_quote_updater_writes_prices_for_all_market_assets(self):
        portfolio = {
            "assets": [
                {"symbol": "00631L", "priceSource": "twse", "currency": "TWD"},
                {"symbol": "NOK", "priceSource": "us", "currency": "USD"},
                {"symbol": "CASH", "priceSource": "fixed", "currency": "TWD"},
            ],
            "usdRate": 32.0,
        }
        fixture = {"USD/TWD": 32.0, "00631L.TW": 35.71, "NOK": 8.52}
        result, quotes = self.run_updater(portfolio, fixture)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(quotes["pricesTWD"]["00631L"], 35.71)
        self.assertEqual(quotes["pricesTWD"]["NOK"], 8.52 * 32.0)
        self.assertEqual(quotes["pricesTWD"]["CASH"], 1.0)
        self.assertIn("updatedAt", quotes)

    def test_transient_source_failure_keeps_previous_quote_and_updates_others(self):
        portfolio = {
            "assets": [
                {"symbol": "BTC", "priceSource": "binance", "currency": "USD"},
                {"symbol": "00631L", "priceSource": "twse", "currency": "TWD"},
            ],
            "usdRate": 32.0,
        }
        fixture = {"USD/TWD": 32.0, "00631L.TW": 35.71}
        previous = {
            "pricesTWD": {"BTC": 2500000.0, "00631L": 35.0},
            "usdRate": 32.0,
            "updatedAt": "2026-01-01T00:00:00Z",
        }
        result, quotes = self.run_updater(portfolio, fixture, previous)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(quotes["pricesTWD"]["BTC"], 2500000.0)
        self.assertEqual(quotes["pricesTWD"]["00631L"], 35.71)


if __name__ == "__main__":
    unittest.main()

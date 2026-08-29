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

    def test_quote_updater_writes_prices_for_all_market_assets(self):
        portfolio = {
            "assets": [
                {"symbol": "00631L", "priceSource": "twse", "currency": "TWD"},
                {"symbol": "NOK", "priceSource": "us", "currency": "USD"},
                {"symbol": "CASH", "priceSource": "fixed", "currency": "TWD"},
            ],
            "usdRate": 32.0,
        }
        fixture = {
            "USD/TWD": 32.0,
            "00631L.TW": 35.71,
            "NOK": 8.52,
        }
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            portfolio_path = tmp / "portfolio.json"
            fixture_path = tmp / "fixture.json"
            output_path = tmp / "quotes.json"
            portfolio_path.write_text(json.dumps(portfolio), encoding="utf-8")
            fixture_path.write_text(json.dumps(fixture), encoding="utf-8")

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

            self.assertEqual(result.returncode, 0, result.stderr)
            quotes = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(quotes["pricesTWD"]["00631L"], 35.71)
            self.assertEqual(quotes["pricesTWD"]["NOK"], 8.52 * 32.0)
            self.assertEqual(quotes["pricesTWD"]["CASH"], 1.0)
            self.assertIn("updatedAt", quotes)


if __name__ == "__main__":
    unittest.main()

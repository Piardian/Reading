"""Provider-backed, matched-horizon policy repricing; never substitutes bond yields for OIS."""
from __future__ import annotations

import datetime as dt
import math
from collections.abc import Mapping
from typing import Any

UTC = dt.timezone.utc


def _time(value: Any) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return parsed.astimezone(UTC) if parsed.tzinfo else None
    except (ValueError, TypeError):
        return None


def build_relative_policy_repricing(market_data: Mapping[str, Any], as_of: dt.datetime | None) -> dict:
    # An explicit clock keeps replay deterministic and prevents accidentally attaching today's curve.
    if as_of is None or as_of.tzinfo is None:
        return {"status": "UNAVAILABLE", "reason": "EXPLICIT_AS_OF_REQUIRED", "pairs": {}}
    now = as_of.astimezone(UTC)
    raw = market_data.get("POLICY_RATE_EXPECTATIONS", {})
    valid: dict[str, dict] = {}
    rejected: dict[str, str] = {}
    for currency, row in (raw.items() if isinstance(raw, Mapping) else []):
        if not isinstance(row, Mapping):
            rejected[str(currency)] = "INVALID_ROW"
            continue
        timestamp, previous = _time(row.get("as_of")), _time(row.get("previous_as_of"))
        rate, old = row.get("implied_rate_pct"), row.get("previous_implied_rate_pct")
        numeric = all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in (rate, old))
        if not numeric or not row.get("source") or not row.get("instrument_id") or not row.get("horizon"):
            rejected[str(currency)] = "MISSING_PROVIDER_OBSERVATIONS"
            continue
        try:
            maturity = dt.date.fromisoformat(str(row.get("maturity_date", "")))
        except ValueError:
            rejected[str(currency)] = "INVALID_MATURITY"
            continue
        if maturity <= now.date():
            rejected[str(currency)] = "EXPIRED_MATURITY"
            continue
        if row.get("instrument_id") != row.get("previous_instrument_id"):
            rejected[str(currency)] = "CONTRACT_ROLL_NOT_COMPARABLE"
            continue
        if not timestamp or not previous or not previous < timestamp <= now or (now - timestamp).total_seconds() > 36 * 3600 or (timestamp - previous).total_seconds() > 7 * 86400:
            rejected[str(currency)] = "STALE_FUTURE_OR_INVALID_TIME"
            continue
        valid[str(currency).upper()] = {**row, "reprice_bps": round((rate - old) * 100, 4)}
    pairs: dict[str, dict] = {}
    for base in sorted(valid):
        for quote in sorted(valid):
            if base == quote:
                continue
            a, b = valid[base], valid[quote]
            # Both legs must describe the same future horizon and comparable observation windows.
            if a["horizon"] != b["horizon"] or a.get("maturity_date") != b.get("maturity_date") or not a.get("maturity_date"):
                continue
            if abs((_time(a["as_of"]) - _time(b["as_of"])).total_seconds()) > 3600 or abs((_time(a["previous_as_of"]) - _time(b["previous_as_of"])).total_seconds()) > 3600:
                continue
            change = round(a["reprice_bps"] - b["reprice_bps"], 4)
            pairs[base + quote] = {
                "status": "AVAILABLE", "horizon": a["horizon"], "maturity_date": a["maturity_date"],
                "rate_differential_bps": round((a["implied_rate_pct"] - b["implied_rate_pct"]) * 100, 4),
                "relative_reprice_bps": change,
                "direction": "LONG" if change >= 3 else "SHORT" if change <= -3 else "NEUTRAL",
                "sources": [a["source"], b["source"]],
            }
    return {"status": "AVAILABLE" if pairs else "UNAVAILABLE", "as_of_utc": now.isoformat(),
            "pairs": pairs, "rejected_inputs": rejected, "methodology": "matched-horizon-policy-repricing-v1",
            "interpretation": "Directional context only; no TP probability, and no fabricated missing currency leg."}

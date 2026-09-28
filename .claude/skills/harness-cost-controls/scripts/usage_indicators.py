#!/usr/bin/env python3
"""
Compute the five harness-cost indicators named in ugcportal-9ak and
~/second-brain/03-professional/AI-USAGE-ECONOMICS.md ("What to measure")
from Claude Code's local transcript logs (~/.claude/projects/**/*.jsonl).

Why this exists: scripts/claude-usage-report.py (lives in the second-brain
vault, not this repo) dedups per-request usage records and dumps them to
/tmp/ccusage/rows.json plus a request count and date range -- it does not
itself compute cache read:write ratio, top-1% spend share, cost-by-component,
subagent spend share, or the 1h-vs-5m cache-write mix. Producing those five
today means re-deriving the aggregation by hand each time. This script reads
the same transcripts independently -- it does not import, wrap, or modify
claude-usage-report.py -- and prints the five indicators directly, so
re-running the measurement is "run this file with the right flags", not
"remember how the aggregation went last time".

Usage:
  python3 usage_indicators.py [--since YYYY-MM-DD] [--project SUBSTRING] [--glob PATTERN]

Indicators (order matches the "What to measure" list this was written against):
  1. Cache read:write token ratio, overall and per day
  2. Share of total spend held by the most expensive 1% of requests
  3. Cost split by component: base input / cache write / cache read / output
  4. Subagent (isSidechain) spend as a share of total spend, with an
     Opus-vs-Sonnet breakdown of that subagent spend (the ugcportal-9ak finding)
  5. 1-hour vs 5-minute cache-write token mix

Pricing is list-price USD per million tokens and mirrors the published rates
used in claude-usage-report.py. For subscription/seat-based access these
dollar figures are notional -- see the note in this skill's SKILL.md. The
*ratios* (1, 4, 5 above) do not depend on the dollar figures being real.
"""
import argparse
import glob as globmod
import json
import os
from collections import defaultdict

# USD per million tokens: (base_input, write_5m, write_1h, cache_read, output)
PRICES = {
    "claude-opus-5": (5, 6.25, 10, 0.50, 25),
    "claude-opus-5-5": (4, 5, 8, 0.20, 20),
    "claude-opus-4-8": (5, 6.25, 10, 0.50, 25),
    "claude-opus-4-7": (5, 6.25, 10, 0.50, 25),
    "claude-opus-4-6": (5, 6.25, 10, 0.50, 25),
    "claude-opus-4-5": (5, 6.25, 10, 0.50, 25),
    "claude-sonnet-5": (2, 2.50, 4, 0.20, 10),
    "claude-sonnet-4-6": (3, 3.75, 6, 0.30, 15),
    "claude-sonnet-4-5": (3, 3.75, 6, 0.30, 15),
    "claude-haiku-4-5": (1, 1.25, 2, 0.10, 5),
    "claude-fable-5-1": (10, 12.50, 20, 0.25, 50),
    "claude-fable-5": (10, 12.50, 20, 1.00, 50),
}
FAST = {"claude-opus-5": (10, 50), "claude-opus-4-8": (10, 50), "claude-opus-5-5": (8, 40)}


def norm_model(m):
    if not m:
        return None
    m = m.split("[")[0]
    for suf in ("-20260401", "-20251001"):
        if m.endswith(suf):
            m = m[: -len(suf)]
    return m


def load_rows(pattern, since, project_substr):
    seen = set()
    rows = []
    for path in globmod.glob(os.path.expanduser(pattern), recursive=True):
        proj = os.path.basename(os.path.dirname(path))
        if project_substr and project_substr not in proj:
            continue
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") != "assistant":
                    continue
                msg = d.get("message") or {}
                u = msg.get("usage")
                if not isinstance(u, dict):
                    continue
                rid = d.get("requestId") or d.get("uuid")
                if not rid or rid in seen:
                    continue
                ts = d.get("timestamp")
                if not ts:
                    continue
                if since and ts[:10] < since:
                    continue
                seen.add(rid)
                model = norm_model(msg.get("model"))
                if model is None or model == "<synthetic>":
                    continue

                cc = u.get("cache_creation", {}) or {}
                w5 = cc.get("ephemeral_5m_input_tokens", 0) or 0
                w1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
                if not (w5 or w1h):
                    w5 = u.get("cache_creation_input_tokens", 0) or 0

                row = {
                    "day": ts[:10],
                    "model": model,
                    "input": u.get("input_tokens", 0) or 0,
                    "w5": w5,
                    "w1h": w1h,
                    "cache_read": u.get("cache_read_input_tokens", 0) or 0,
                    "output": u.get("output_tokens", 0) or 0,
                    "is_sidechain": bool(d.get("isSidechain")),
                }
                if model in PRICES:
                    bi, p5, p1, pr, po = PRICES[model]
                    if u.get("speed") == "fast" and model in FAST:
                        bi, po = FAST[model]
                        p5, p1, pr = bi * 1.25, bi * 2, bi * 0.1
                    geo = 1.1 if u.get("inference_geo") == "us" else 1.0
                    row["cost_input"] = geo * row["input"] * bi / 1e6
                    row["cost_w5"] = geo * row["w5"] * p5 / 1e6
                    row["cost_w1h"] = geo * row["w1h"] * p1 / 1e6
                    row["cost_read"] = geo * row["cache_read"] * pr / 1e6
                    row["cost_output"] = geo * row["output"] * po / 1e6
                else:
                    row["cost_input"] = row["cost_w5"] = row["cost_w1h"] = 0.0
                    row["cost_read"] = row["cost_output"] = 0.0
                row["cost"] = (
                    row["cost_input"] + row["cost_w5"] + row["cost_w1h"]
                    + row["cost_read"] + row["cost_output"]
                )
                rows.append(row)
    return rows


def report(rows):
    if not rows:
        print("no requests matched")
        return
    total_cost = sum(r["cost"] for r in rows)
    n = len(rows)
    print(f"requests: {n:,}  total spend (list price): ${total_cost:,.2f}")
    print()

    # 1. Cache read:write ratio, overall and per day
    total_read = sum(r["cache_read"] for r in rows)
    total_write = sum(r["w5"] + r["w1h"] for r in rows)
    overall_ratio = (total_read / total_write) if total_write else float("inf")
    print(f"1. Cache read:write ratio (tokens) -- overall: {overall_ratio:,.1f} : 1")
    by_day = defaultdict(lambda: [0, 0])
    for r in rows:
        by_day[r["day"]][0] += r["cache_read"]
        by_day[r["day"]][1] += r["w5"] + r["w1h"]
    for day in sorted(by_day):
        rd, wr = by_day[day]
        ratio = (rd / wr) if wr else float("inf")
        print(f"   {day}: {ratio:,.1f} : 1")
    print()

    # 2. Share of spend in top 1% of requests
    sorted_costs = sorted((r["cost"] for r in rows), reverse=True)
    top_n = max(1, round(n * 0.01))
    top_share = (sum(sorted_costs[:top_n]) / total_cost) if total_cost else 0
    print(f"2. Top 1% of requests ({top_n} of {n:,}) hold {top_share * 100:.1f}% of spend")
    print()

    # 3. Cost split by component
    comp = {
        "base input": sum(r["cost_input"] for r in rows),
        "cache write (5m+1h)": sum(r["cost_w5"] + r["cost_w1h"] for r in rows),
        "cache read": sum(r["cost_read"] for r in rows),
        "output": sum(r["cost_output"] for r in rows),
    }
    print("3. Cost split by component:")
    for k, v in comp.items():
        pct = (v / total_cost * 100) if total_cost else 0
        print(f"   {k}: ${v:,.2f} ({pct:.1f}%)")
    print()

    # 4. Subagent spend share, plus the Opus-vs-Sonnet split within it
    sub_rows = [r for r in rows if r["is_sidechain"]]
    sub_cost = sum(r["cost"] for r in sub_rows)
    pct = (sub_cost / total_cost * 100) if total_cost else 0
    print(
        f"4. Subagent (isSidechain) spend: ${sub_cost:,.2f} of ${total_cost:,.2f} "
        f"({pct:.1f}%), {len(sub_rows):,} of {n:,} requests"
    )
    opus_sub_cost = sum(r["cost"] for r in sub_rows if r["model"].startswith("claude-opus"))
    sonnet_sub_cost = sum(r["cost"] for r in sub_rows if r["model"].startswith("claude-sonnet"))
    opus_sub_n = sum(1 for r in sub_rows if r["model"].startswith("claude-opus"))
    sonnet_sub_n = sum(1 for r in sub_rows if r["model"].startswith("claude-sonnet"))
    print(
        f"   of which Opus: ${opus_sub_cost:,.2f} ({opus_sub_n:,} reqs), "
        f"Sonnet: ${sonnet_sub_cost:,.2f} ({sonnet_sub_n:,} reqs)"
    )
    if opus_sub_cost:
        print(f"   Opus subagent spend at Sonnet rates would be ~${opus_sub_cost * 0.4:,.2f} "
              f"(Sonnet 5 is 0.4x Opus 5 on every pricing line)")
    print()

    # 5. 1h vs 5m cache-write mix
    w5_total = sum(r["w5"] for r in rows)
    w1h_total = sum(r["w1h"] for r in rows)
    wtotal = w5_total + w1h_total
    pct5 = (w5_total / wtotal * 100) if wtotal else 0
    pct1h = (w1h_total / wtotal * 100) if wtotal else 0
    print(f"5. Cache-write tier mix (tokens): 5-minute {pct5:.1f}%, 1-hour {pct1h:.1f}%")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", help="YYYY-MM-DD, inclusive")
    ap.add_argument("--project", help="substring to match against the project dir name")
    ap.add_argument(
        "--glob",
        default="~/.claude/projects/**/*.jsonl",
        help="override the transcript glob (mainly for tests)",
    )
    args = ap.parse_args()
    rows = load_rows(args.glob, args.since, args.project)
    report(rows)


if __name__ == "__main__":
    main()

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
  4. Subagent (isSidechain) spend as a share of total spend, partitioned into
     Opus / Sonnet / other so the parts always reconcile to the total
  5. 1-hour vs 5-minute cache-write mix, in both tokens and dollars, including
     what the window's actual cache-write spend would have been under an
     all-1-hour or all-5-minute hypothetical

Pricing is list-price USD per million tokens and mirrors the published rates
used in claude-usage-report.py. For subscription/seat-based access these
dollar figures are notional -- see the note in this skill's SKILL.md. The
*ratios* (1, 4, 5 above) do not depend on the dollar figures being real.

A NOTE ON FAILURE DIRECTION (round-1 and round-2 PR review, 2026-09-28): an
earlier version of this script had several bugs -- a wrong project-slug path,
a first-seen-wins dedup, a silently-zeroed unpriced-model cost, an inverted
comment, a subagent breakdown that didn't reconcile to its own total, and
silent skip paths with no tally -- and every one of them failed in the SAME
direction: each made a real regression, or a real gap in the script's own
coverage, look like a clean result instead of an error. Round 2 also found
that the round-1 fix's own docstring overclaimed test coverage that didn't
exist yet. This is now a committed self-test
(test_usage_indicators.py, alongside this file -- run it with
`python3 -m unittest test_usage_indicators -v` from this directory), plus:
every filter and scan step below counts what it skipped and why, `report()`
echoes the scan (files matched, files unreadable, lines skipped and why, the
filters used, the date range actually covered) before printing a single
indicator, and `--since` rejects a malformed date instead of silently
matching the wrong window. If you change this file: run the self-test, and
ask which direction a mistake here would point the reader before asking
whether the printed number looks right.
"""
import argparse
import collections
import datetime
import glob as globmod
import json
import os
import sys

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
# Every entry above prices a cache read at ~10% of base input EXCEPT
# claude-opus-5-5 (0.20/4 = 5%) and claude-fable-5-1 (0.25/10 = 2.5%). Both
# are copied verbatim from claude-usage-report.py, not derived here. The
# fast-speed reprice below derives its cache-read rate from each model's own
# ratio specifically so this anomaly can't silently become a 2x mispricing.
# The claude-fable-5-1 figure looks like a typo (understates Fable cache-read
# spend ~4x if the intended ratio was the usual 10%) but this script does not
# own that table's source of truth -- tracked as ugcportal-xwt rather than
# guessed at and "corrected" here.
FAST = {"claude-opus-5": (10, 50), "claude-opus-4-8": (10, 50), "claude-opus-5-5": (8, 40)}

# Sonnet-equivalent counterfactual: which Sonnet model a given Opus model's
# subagent spend would have cost at, IF that pairing has actually been
# verified to hold across every pricing line (not assumed). Only claude-opus-5
# vs claude-sonnet-5 has been checked this way (ugcportal-9ak: exactly 0.4x on
# every line: base input, both cache-write tiers, cache read, output). Do not
# add an entry here without checking all five lines the same way -- a wrong
# ratio silently printed as "would have cost" is exactly the failure shape
# this file exists to avoid. (For the record, since a flat ratio was wrong
# once already: claude-sonnet-4-x prices at 0.6x claude-opus-4-x, not 0.4x --
# not the other way around, and not currently used below because it has not
# been double-checked against every pricing line the way opus-5/sonnet-5 has.)
VERIFIED_OPUS_TO_SONNET_RATIO = {
    "claude-opus-5": ("claude-sonnet-5", 0.4),
}


def norm_model(m):
    if not m:
        return None
    m = m.split("[")[0]
    for suf in ("-20260401", "-20251001"):
        if m.endswith(suf):
            m = m[: -len(suf)]
    return m


def valid_since_date(s):
    """argparse type= validator: reject anything that isn't a full YYYY-MM-DD.

    load_rows compares this string against a row's local date with a plain
    `>=`, which only means what it looks like it means if both sides are a
    full ISO date. Before this validator existed, `--since 2026-09` compared
    as a string prefix and silently matched (and therefore INCLUDED) every
    day in September and every month after it, and `--since 2026-9-24`
    (missing zero-padding) silently matched nothing -- neither mistake was
    visible anywhere in the output.
    """
    try:
        datetime.date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"must be a full date, YYYY-MM-DD (got {s!r}); a partial date like "
            f"'2026-09' silently widens the window instead of erroring, which is "
            f"exactly the failure mode this validator exists to prevent"
        )
    return s


def _price_row(row, model, u):
    """Fill in row's cost_* fields (and the per-tier rates indicator 5 needs
    for its hypothetical-cost comparison). Returns True if model was priced,
    False if unpriced (every cost field, including the rates, is then 0.0)."""
    if model not in PRICES:
        row["cost_input"] = row["cost_w5"] = row["cost_w1h"] = 0.0
        row["cost_read"] = row["cost_output"] = 0.0
        row["cost"] = 0.0
        row["_p5_rate"] = row["_p1_rate"] = row["_geo"] = 0.0
        return False
    bi, p5, p1, pr, po = PRICES[model]
    if u.get("speed") == "fast" and model in FAST:
        # Preserve THIS model's own cache-read-to-base-input ratio rather than
        # assuming the common 10% -- claude-opus-5-5 and claude-fable-5-1 do
        # not follow it (see the PRICES comment above), and a flat `bi * 0.1`
        # would silently double-price a fast opus-5-5 cache read.
        read_ratio = (pr / bi) if bi else 0.1
        bi, po = FAST[model]
        p5, p1, pr = bi * 1.25, bi * 2, bi * read_ratio
    geo = 1.1 if u.get("inference_geo") == "us" else 1.0
    row["cost_input"] = geo * row["input"] * bi / 1e6
    row["cost_w5"] = geo * row["w5"] * p5 / 1e6
    row["cost_w1h"] = geo * row["w1h"] * p1 / 1e6
    row["cost_read"] = geo * row["cache_read"] * pr / 1e6
    row["cost_output"] = geo * row["output"] * po / 1e6
    row["cost"] = (
        row["cost_input"] + row["cost_w5"] + row["cost_w1h"]
        + row["cost_read"] + row["cost_output"]
    )
    row["_p5_rate"] = p5
    row["_p1_rate"] = p1
    row["_geo"] = geo
    return True


def load_rows(pattern, since, project_substr):
    """
    Returns (rows, unpriced, diagnostics).

    unpriced is a Counter of model -> request count for models absent from
    PRICES (excluded from every dollar figure, still counted in `n` and in
    the token-based indicators), tallied from the FINAL filtered row set.

    diagnostics is a dict describing the scan itself -- files matched, files
    that could not be opened, and lines dropped during parsing and why --
    so a partially-unreadable transcript tree is visible in the output
    rather than silently producing a smaller, confident number.

    Project-slug resolution: transcripts for a given project all live under
    one directory tree rooted at the non-wildcard prefix of `pattern` (by
    default ~/.claude/projects/<slug>/...), but subagent transcripts nest an
    extra two levels down (<slug>/<session-uuid>/subagents/agent-*.jsonl).
    Taking the immediate parent directory name -- the earlier approach --
    reads "subagents" for every one of those files instead of the actual
    slug, so a --project filter silently drops all subagent traffic instead
    of matching it. Walking the path relative to the pattern's root and
    taking the FIRST component fixes this regardless of nesting depth, and
    still works against a --glob pointing at a flat test fixture.
    """
    expanded_pattern = os.path.expanduser(pattern)
    base_dir = expanded_pattern.split("*", 1)[0].rstrip(os.sep)

    best = {}  # requestId -> row dict, keeping the highest output_tokens seen
    skipped = collections.Counter()  # reason -> count, see the loop below
    files_matched = 0
    files_unreadable = 0

    for path in globmod.glob(expanded_pattern, recursive=True):
        files_matched += 1
        rel = os.path.relpath(path, base_dir)
        proj = rel.split(os.sep)[0]
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            files_unreadable += 1
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    skipped["json_error"] += 1
                    continue
                if d.get("type") != "assistant":
                    continue
                msg = d.get("message") or {}
                u = msg.get("usage")
                if not isinstance(u, dict):
                    continue
                rid = d.get("requestId") or d.get("uuid")
                if not rid:
                    skipped["missing_id"] += 1
                    continue
                ts = d.get("timestamp")
                if not ts:
                    skipped["missing_timestamp"] += 1
                    continue

                is_sidechain = bool(d.get("isSidechain"))

                model = norm_model(msg.get("model"))
                if model is None or model == "<synthetic>":
                    continue

                # Claude Code writes one "assistant" line per content block
                # for a single API request, all sharing requestId; input and
                # cache_read repeat identically across them but output_tokens
                # grows to its final value only on the last line. Keeping the
                # first-seen line (or any but the max) undercounts output --
                # measured 48% understated across the real transcript tree.
                # Keep whichever line has the highest output_tokens.
                output = u.get("output_tokens", 0) or 0
                prev = best.get(rid)
                if prev is not None and output <= prev["_output"]:
                    continue

                # claude-usage-report.py buckets days with `.astimezone()`
                # (local time); this must match so a reader comparing this
                # script's daily/--since figures against that one, or against
                # AI-USAGE-ECONOMICS.md, isn't silently off by a boundary.
                dt = datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone()
                day = dt.date().isoformat()

                cc = u.get("cache_creation", {}) or {}
                w5 = cc.get("ephemeral_5m_input_tokens", 0) or 0
                w1h = cc.get("ephemeral_1h_input_tokens", 0) or 0
                if not (w5 or w1h):
                    w5 = u.get("cache_creation_input_tokens", 0) or 0

                row = {
                    "day": day,
                    "proj": proj,
                    "model": model,
                    "input": u.get("input_tokens", 0) or 0,
                    "w5": w5,
                    "w1h": w1h,
                    "cache_read": u.get("cache_read_input_tokens", 0) or 0,
                    "output": output,
                    "is_sidechain": is_sidechain,
                    "_output": output,
                }
                row["_priced"] = _price_row(row, model, u)
                best[rid] = row

    rows = list(best.values())
    if since:
        rows = [r for r in rows if r["day"] >= since]

    if project_substr:
        unfiltered_sidechain = sum(1 for r in rows if r["is_sidechain"])
        kept = [r for r in rows if project_substr in r["proj"]]
        kept_sidechain = sum(1 for r in kept if r["is_sidechain"])
        if unfiltered_sidechain > 0 and kept_sidechain == 0:
            print(
                f"WARNING: --project {project_substr!r} matched {len(kept):,} requests and "
                f"ZERO isSidechain ones, even though {unfiltered_sidechain:,} exist across "
                f"everything else this run scanned before the project filter. This is exactly "
                f"the shape of a filter silently eating the thing it is supposed to measure -- "
                f"verify the project slug (see the --project help text) before trusting a 0% "
                f"subagent share.",
                file=sys.stderr,
            )
        rows = kept

    # Tally unpriced models from the FINAL filtered row set, not the raw
    # per-line scan -- a model's only occurrences can be filtered out by
    # --since or --project, and reporting it anyway would show "unpriced: X"
    # next to a set of numbers that has nothing to do with X.
    unpriced = collections.Counter(r["model"] for r in rows if not r["_priced"])

    diagnostics = {
        "glob_pattern": pattern,
        "files_matched": files_matched,
        "files_unreadable": files_unreadable,
        "skipped_json_error": skipped["json_error"],
        "skipped_missing_id": skipped["missing_id"],
        "skipped_missing_timestamp": skipped["missing_timestamp"],
        "since_filter": since,
        "project_filter": project_substr,
    }

    return rows, unpriced, diagnostics


def report(rows, unpriced, diagnostics):
    # Echo the scan itself BEFORE anything else, including before the
    # "no requests matched" early return -- a bad filter, an unreadable
    # file, or a malformed date all still produce a plausible-looking
    # (small) result if this isn't printed, which is the whole reason it
    # is here rather than left as a diagnostic someone has to ask for.
    unreadable_note = (
        f" ({diagnostics['files_unreadable']:,} unreadable)" if diagnostics["files_unreadable"] else ""
    )
    print(
        f"scanned {diagnostics['files_matched']:,} files matching "
        f"{diagnostics['glob_pattern']!r}{unreadable_note}"
    )
    skip_total = (
        diagnostics["skipped_json_error"]
        + diagnostics["skipped_missing_id"]
        + diagnostics["skipped_missing_timestamp"]
    )
    if skip_total:
        print(
            f"skipped {skip_total:,} lines while parsing: "
            f"{diagnostics['skipped_json_error']:,} unparseable JSON, "
            f"{diagnostics['skipped_missing_id']:,} missing a request id, "
            f"{diagnostics['skipped_missing_timestamp']:,} missing a timestamp"
        )
    print(
        f"filters used: --since={diagnostics['since_filter'] or 'none'}  "
        f"--project={diagnostics['project_filter'] or 'none'}"
    )
    if rows:
        days = sorted(r["day"] for r in rows)
        print(f"date range actually covered by the kept requests: {days[0]} .. {days[-1]} (local dates)")
    print()

    if not rows:
        print("no requests matched")
        return
    total_cost = sum(r["cost"] for r in rows)
    n = len(rows)
    print(f"requests: {n:,}  total spend (list price): ${total_cost:,.2f}")
    if unpriced:
        total_unpriced = sum(unpriced.values())
        print(
            f"** UNPRICED MODELS (excluded from every dollar figure below; still counted in "
            f"the {n:,} requests above and in the token-based indicators 1/4/5): "
            f"{dict(unpriced)} -- {total_unpriced:,} requests. Actual total spend is at least "
            f"this much higher than what is reported below. Add the model to PRICES to fix. **"
        )
    print()

    # 1. Cache read:write ratio, overall and per day
    total_read = sum(r["cache_read"] for r in rows)
    total_write = sum(r["w5"] + r["w1h"] for r in rows)
    overall_ratio = (total_read / total_write) if total_write else float("inf")
    print(f"1. Cache read:write ratio (tokens) -- overall: {overall_ratio:,.1f} : 1")
    by_day = collections.defaultdict(lambda: [0, 0])
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

    # 4. Subagent spend share, partitioned into Opus / Sonnet / other so the
    # parts always reconcile to the whole -- an earlier version reported only
    # an Opus and a Sonnet line, so any Fable or Haiku subagent spend was in
    # the total and in no sub-line at all.
    sub_rows = [r for r in rows if r["is_sidechain"]]
    sub_cost = sum(r["cost"] for r in sub_rows)
    pct = (sub_cost / total_cost * 100) if total_cost else 0
    print(
        f"4. Subagent (isSidechain) spend: ${sub_cost:,.2f} of ${total_cost:,.2f} "
        f"({pct:.1f}%), {len(sub_rows):,} of {n:,} requests"
    )
    opus_rows = [r for r in sub_rows if r["model"].startswith("claude-opus")]
    sonnet_rows = [r for r in sub_rows if r["model"].startswith("claude-sonnet")]
    other_rows = [
        r for r in sub_rows
        if not r["model"].startswith("claude-opus") and not r["model"].startswith("claude-sonnet")
    ]
    opus_sub_cost = sum(r["cost"] for r in opus_rows)
    sonnet_sub_cost = sum(r["cost"] for r in sonnet_rows)
    other_sub_cost = sum(r["cost"] for r in other_rows)
    other_models = sorted({r["model"] for r in other_rows})
    print(
        f"   of which Opus: ${opus_sub_cost:,.2f} ({len(opus_rows):,} reqs), "
        f"Sonnet: ${sonnet_sub_cost:,.2f} ({len(sonnet_rows):,} reqs), "
        f"other ({other_models or 'none'}): ${other_sub_cost:,.2f} ({len(other_rows):,} reqs) "
        f"-- reconciles to ${opus_sub_cost + sonnet_sub_cost + other_sub_cost:,.2f} of "
        f"${sub_cost:,.2f}"
    )
    # The Sonnet-rate counterfactual only applies to Opus models whose exact
    # per-line ratio to a Sonnet model has actually been checked (see
    # VERIFIED_OPUS_TO_SONNET_RATIO above) -- applying a single flat ratio to
    # every "claude-opus*" row was wrong the moment a second Opus generation
    # appeared (claude-sonnet-4-x prices at 0.6x claude-opus-4-x, not 0.4x --
    # not applied here because it hasn't been checked line-by-line the way
    # opus-5/sonnet-5 has).
    for opus_model, (sonnet_model, ratio) in VERIFIED_OPUS_TO_SONNET_RATIO.items():
        model_cost = sum(r["cost"] for r in sub_rows if r["model"] == opus_model)
        if model_cost:
            print(
                f"   {opus_model} subagent spend at {sonnet_model} rates would be "
                f"~${model_cost * ratio:,.2f} ({sonnet_model} is exactly {ratio}x "
                f"{opus_model} on every pricing line -- this ratio is not applied to "
                f"any other Opus generation)"
            )
    verified_models = set(VERIFIED_OPUS_TO_SONNET_RATIO.keys())
    unverified_opus_cost = sum(
        r["cost"] for r in opus_rows if r["model"] not in verified_models
    )
    unverified_opus_models = sorted({r["model"] for r in opus_rows if r["model"] not in verified_models})
    if unverified_opus_cost:
        print(
            f"   Additionally, ${unverified_opus_cost:,.2f} of subagent spend was on "
            f"{unverified_opus_models} -- no verified exact Sonnet-equivalent ratio is applied "
            f"to these; check per-model rates in PRICES before assuming any fixed multiplier"
        )
    print()

    # 5. 1h vs 5m cache-write mix, in tokens and in dollars
    w5_total = sum(r["w5"] for r in rows)
    w1h_total = sum(r["w1h"] for r in rows)
    wtotal = w5_total + w1h_total
    pct5 = (w5_total / wtotal * 100) if wtotal else 0
    pct1h = (w1h_total / wtotal * 100) if wtotal else 0
    print(f"5. Cache-write tier mix (tokens): 5-minute {pct5:.1f}%, 1-hour {pct1h:.1f}%")
    # Hypothetical cost comparison, computed from THIS window's own rows and
    # THIS window's own per-model rates -- not a number copied from a
    # different window (a round-2 finding: an earlier draft of SKILL.md
    # quoted a "$46 1-hour premium" from a differently-scoped 24-day report,
    # which this indicator cannot reproduce and which is off by roughly 10x
    # for the window this file actually documents). "All-5-minute" should
    # equal the actual spend whenever indicator 5 already reads 100% 5m --
    # that equality is a built-in sanity check on this calculation, not a
    # coincidence.
    priced_rows = [r for r in rows if r["_priced"]]
    actual_write_cost = sum(r["cost_w5"] + r["cost_w1h"] for r in priced_rows)
    hypothetical_all_1h = sum(
        (r["w5"] + r["w1h"]) * r["_p1_rate"] / 1e6 * r["_geo"] for r in priced_rows
    )
    hypothetical_all_5m = sum(
        (r["w5"] + r["w1h"]) * r["_p5_rate"] / 1e6 * r["_geo"] for r in priced_rows
    )
    print(
        f"   actual cache-write spend: ${actual_write_cost:,.2f}  |  hypothetical if ALL "
        f"cache-write tokens in this window had gone through the 1-hour tier instead of "
        f"their actual tier: ${hypothetical_all_1h:,.2f} (a premium of "
        f"${hypothetical_all_1h - hypothetical_all_5m:,.2f} over an all-5-minute "
        f"hypothetical of ${hypothetical_all_5m:,.2f})"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "--since",
        type=valid_since_date,
        help="YYYY-MM-DD, inclusive (compared against the request's LOCAL date, matching "
        "claude-usage-report.py's .astimezone()); rejected if not a full date",
    )
    ap.add_argument(
        "--project",
        help="substring to match against the project slug (the directory directly under "
        "the projects root -- not necessarily a matched file's immediate parent, since "
        "subagent transcripts nest deeper)",
    )
    ap.add_argument(
        "--glob",
        default="~/.claude/projects/**/*.jsonl",
        help="override the transcript glob (mainly for tests)",
    )
    args = ap.parse_args()
    rows, unpriced, diagnostics = load_rows(args.glob, args.since, args.project)
    report(rows, unpriced, diagnostics)


if __name__ == "__main__":
    main()

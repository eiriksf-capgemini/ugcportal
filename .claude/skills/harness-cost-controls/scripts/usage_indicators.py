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

A NOTE ON FAILURE DIRECTION (three rounds of PR review, 2026-09-28): earlier
versions of this script had a long list of bugs -- a wrong project-slug
path, a first-seen-wins dedup, a silently-zeroed unpriced-model cost, an
inverted comment, a subagent breakdown that didn't reconcile to its own
total, silent skip paths with no tally, a model-id normalizer that only
covered two hardcoded date stamps, an unvalidated --since that a newer
Python parses more leniently than this script expected, and a glob-base-dir
computation that broke on a narrowing glob -- and nearly every one of them
failed in the SAME direction: each made a real regression, or a real gap in
the script's own coverage, look like a clean result instead of an error.
That recurrence, across three separate review rounds, is the reason the
fix below is structural rather than one more patch: every path that drops,
skips, or fails to price a record increments a key in the single
`ANOMALY_KEYS` ledger, and `report()`'s first job -- before it prints a
single dollar figure -- is to print all of them, including as an explicit
zero. A committed self-test (test_usage_indicators.py, alongside this file
-- run `python3 -m unittest test_usage_indicators -v` from this directory)
backs every fix with a test that fails when the fix is reverted; that self-
test is run BY HAND, and nothing in this repo's CI runs it (tracked as a
known gap, not a claim otherwise -- see SKILL.md). If you change this file:
run the self-test, ask which direction a mistake here would point the
reader, and ask whether the mistake would actually show up in the
`ANOMALY_KEYS` ledger -- if it wouldn't, the ledger is missing a key, which
is exactly how three of these bugs were found.
"""
import argparse
import collections
import datetime
import glob as globmod
import json
import os
import re
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


_DATE_SUFFIX_RE = re.compile(r"-\d{8}$")
_GLOB_META_CHARS = frozenset("*?[")


def norm_model(m):
    """Strip a trailing date-snapshot suffix (e.g. "-20260401") and an
    inference-region bracket suffix (e.g. "[1m]") from a raw model id.

    Round 3 found this hardcoded a two-entry list of exact suffixes seen so
    far. Any OTHER date stamp -- a new snapshot like "-20260601", or one
    that just hadn't been added yet -- falls straight through unstripped,
    fails the PRICES lookup, and reports as an unpriced/unrecognized model:
    a real request landing in "of which Opus: $0.00 (N reqs)" instead of
    being priced. A regex on the actual shape of the suffix (8 digits) fixes
    the whole class instead of one entry at a time.
    """
    if not m:
        return None
    m = m.split("[")[0]
    m = _DATE_SUFFIX_RE.sub("", m)
    return m


def valid_since_date(s):
    """argparse type= validator: reject anything that isn't a full YYYY-MM-DD,
    and return the CANONICAL isoformat string rather than the input verbatim.

    load_rows compares this string against a row's local date with a plain
    `>=`, which only means what it looks like it means if both sides are a
    full, canonical ISO date. Before this validator existed at all,
    `--since 2026-09` compared as a string prefix and silently matched (and
    therefore INCLUDED) every day in September and every month after it, and
    `--since 2026-9-24` (missing zero-padding) silently matched nothing.

    Returning `s` unchanged (an earlier version of this validator) reintroduces
    a narrower version of the same bug on Python >= 3.11, where
    `date.fromisoformat` itself became lenient enough to accept
    `--since 20260924` (basic ISO 8601, no dashes) and `--since 2026-W40-1`
    (an ISO week date) -- both parse to valid dates, but the ORIGINAL string
    is not `YYYY-MM-DD`, so comparing it against `row["day"]` compares
    "20260924" or "2026-W40-1" against "2026-09-24" and silently matches
    nothing. Reproduced on Python 3.14.7: both inputs pass this validator and
    then `--since 2026-09-24`-equivalent data reports "no requests matched"
    over thousands of requests that actually match. Returning
    `d.isoformat()` normalizes to `YYYY-MM-DD` regardless of which
    ISO-8601 variant the caller typed or which Python version parsed it.
    """
    try:
        d = datetime.date.fromisoformat(s)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"must be a full date, YYYY-MM-DD (got {s!r}); a partial date like "
            f"'2026-09' silently widens the window instead of erroring, which is "
            f"exactly the failure mode this validator exists to prevent"
        )
    return d.isoformat()


def glob_base_dir(expanded_pattern):
    """The deepest directory in `expanded_pattern` containing no glob
    metacharacter -- the root every matched file's project slug is resolved
    relative to.

    An earlier version cut the pattern at the first literal '*' character
    (`pattern.split("*", 1)[0]`), which is correct only when that '*' starts
    its own path component. A narrowing glob like
    "~/.claude/projects/ugc*/**/*.jsonl" puts the '*' MID-COMPONENT, so that
    approach produced the partial, non-existent path ".../projects/ugc" as
    the base. `os.path.relpath` then treats "ugc" as a sibling rather than
    an ancestor of the real "ugcportal" directory, so every resolved
    project slug comes out as "..", and any --project filter matches
    nothing. Reproduced with such a glob. Walking whole path components and
    stopping at the first one containing a glob metacharacter fixes this
    for a glob anchored anywhere, not just at "**".
    """
    parts = expanded_pattern.split(os.sep)
    base_parts = []
    for part in parts:
        if any(ch in part for ch in _GLOB_META_CHARS):
            break
        base_parts.append(part)
    return os.sep.join(base_parts) or os.sep


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


# Every one of these keys is printed by report() UNCONDITIONALLY, including
# when its count is zero. Round 3 found three more silent `continue` paths
# (non-assistant, non-dict usage, unrecognized model) alongside the ones
# round 2 had already started counting -- the recurrence across three
# rounds is the point: a per-case fix does not generalize, because the next
# silent path is just as easy to add as the last one was to miss. The fix
# that generalizes is structural: every path that drops or fails to price a
# record increments a key in THIS dict, and report()'s first job, before it
# prints a single dollar figure, is to print all of them. An unlisted drop
# path is a bug in this list, not a silent number.
ANOMALY_KEYS = (
    "files_unreadable",
    "lines_json_error",
    "lines_missing_id",
    "lines_missing_timestamp",
    "lines_not_assistant_with_usage",
    "lines_usage_not_dict",
    "lines_unrecognized_model",
)


def load_rows(pattern, since, project_substr):
    """
    Returns (rows, unpriced, diagnostics).

    unpriced is a Counter of model -> request count for models absent from
    PRICES (excluded from every dollar figure, still counted in `n` and in
    the token-based indicators), tallied from the FINAL filtered row set.

    diagnostics is a dict describing the scan itself -- files matched, an
    anomalies sub-dict keyed by ANOMALY_KEYS (see above), and the filters
    actually used -- so a partially-unreadable transcript tree, an
    unparseable record, or an unrecognized model is visible in the output
    rather than silently producing a smaller, confident number.

    Project-slug resolution: transcripts for a given project all live under
    one directory tree rooted at the deepest glob-metacharacter-free prefix
    of `pattern` (by default ~/.claude/projects/<slug>/...; see
    glob_base_dir), but subagent transcripts nest an extra two levels down
    (<slug>/<session-uuid>/subagents/agent-*.jsonl). Taking the immediate
    parent directory name -- an earlier approach -- reads "subagents" for
    every one of those files instead of the actual slug, so a --project
    filter silently drops all subagent traffic instead of matching it.
    Walking the path relative to the base dir and taking the FIRST
    component fixes this regardless of nesting depth, and still works
    against a --glob pointing at a flat test fixture.
    """
    expanded_pattern = os.path.expanduser(pattern)
    base_dir = glob_base_dir(expanded_pattern)

    best = {}  # requestId -> row dict, keeping the highest output_tokens seen
    anomalies = collections.Counter()  # key from ANOMALY_KEYS -> count
    files_matched = 0

    for path in globmod.glob(expanded_pattern, recursive=True):
        files_matched += 1
        rel = os.path.relpath(path, base_dir)
        proj = rel.split(os.sep)[0]
        try:
            fh = open(path, encoding="utf-8", errors="replace")
        except OSError:
            anomalies["files_unreadable"] += 1
            continue
        with fh:
            for line in fh:
                if '"usage"' not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    anomalies["lines_json_error"] += 1
                    continue
                if d.get("type") != "assistant":
                    # Contains the substring '"usage"' but isn't an
                    # assistant turn -- e.g. a tool result embedding the
                    # word elsewhere in its payload. Not necessarily a
                    # problem, but round 3 found 45 of these in the real
                    # tree with nothing counting them; tallied rather than
                    # silently absorbed.
                    anomalies["lines_not_assistant_with_usage"] += 1
                    continue
                msg = d.get("message") or {}
                u = msg.get("usage")
                if not isinstance(u, dict):
                    anomalies["lines_usage_not_dict"] += 1
                    continue
                rid = d.get("requestId") or d.get("uuid")
                if not rid:
                    anomalies["lines_missing_id"] += 1
                    continue
                ts = d.get("timestamp")
                if not ts:
                    anomalies["lines_missing_timestamp"] += 1
                    continue

                is_sidechain = bool(d.get("isSidechain"))

                model = norm_model(msg.get("model"))
                if model is None or model == "<synthetic>":
                    anomalies["lines_unrecognized_model"] += 1
                    continue

                # Claude Code writes one "assistant" line per content block
                # for a single API request, all sharing requestId; input and
                # cache_read repeat identically across them but output_tokens
                # grows to its final value only on the last line. Keeping the
                # first-seen line (or any but the max) undercounts output --
                # measured 64.0% understated on the since-2026-09-24 window
                # this file's own baseline uses (48.8% understated over this
                # machine's full available history, a different, wider
                # denominator -- both are real, re-measured 2026-09-28, not
                # a discrepancy). Keep whichever line has the highest
                # output_tokens.
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
        "anomalies": {key: anomalies[key] for key in ANOMALY_KEYS},
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
    print(f"scanned {diagnostics['files_matched']:,} files matching {diagnostics['glob_pattern']!r}")

    # THE CHOKEPOINT: every anomaly key from ANOMALY_KEYS, printed
    # unconditionally -- including as an explicit 0 -- so that "nothing is
    # wrong" and "we didn't check" never look the same. This one block is
    # what round 3 asked for instead of one more per-case tally: whatever
    # the next silent drop path turns out to be, it has to increment a key
    # in `anomalies` to be counted at all, and once it does, it prints here
    # by construction, not because someone remembered to add a print
    # statement next to it.
    print("anomalies while scanning (0 = clean; see ANOMALY_KEYS for what each counts):")
    for key in ANOMALY_KEYS:
        print(f"   {key}: {diagnostics['anomalies'][key]:,}")
    print(f"   unpriced_models: {dict(unpriced) if unpriced else '{}'}")

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

    def _unpriced_note(group_rows):
        # "Loud wherever it appears", not just in the top-of-report banner:
        # a bucket whose cost is $0 because every row in it is unpriced
        # (round 3, medium 1) must say so on the SAME line as that $0,
        # since a reader looking at "of which Opus: $0.00 (N reqs)" in
        # isolation has no reason to scroll back up to the anomalies ledger.
        n_unpriced = sum(1 for r in group_rows if not r["_priced"])
        return f", {n_unpriced} unpriced" if n_unpriced else ""

    print(
        f"   of which Opus: ${opus_sub_cost:,.2f} ({len(opus_rows):,} reqs"
        f"{_unpriced_note(opus_rows)}), "
        f"Sonnet: ${sonnet_sub_cost:,.2f} ({len(sonnet_rows):,} reqs"
        f"{_unpriced_note(sonnet_rows)}), "
        f"other ({other_models or 'none'}): ${other_sub_cost:,.2f} ({len(other_rows):,} reqs"
        f"{_unpriced_note(other_rows)}) "
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

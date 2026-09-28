#!/usr/bin/env python3
"""
Self-test for usage_indicators.py, referenced by that module's own docstring.

Run from this directory:
  python3 -m unittest test_usage_indicators -v

Each test builds a small synthetic transcript tree under a TemporaryDirectory
(mirroring the real ~/.claude/projects/<slug>/... layout, including the
nested <slug>/<session-uuid>/subagents/agent-*.jsonl path subagent
transcripts actually use) and asserts against load_rows()/report()'s output
directly, rather than against a real machine's transcripts -- so this passes
the same way on any machine or CI runner regardless of what's actually been
run there.

These tests exist because round 1 of ugcportal-9ak's PR review found six bugs
in usage_indicators.py that each look like good news instead of an error
(see that module's docstring), and round 2 found that the round-1 fix's own
docstring claimed test coverage that didn't exist yet. This file is what
makes that claim true.
"""
import datetime
import os
import sys
import unittest
from io import StringIO
from contextlib import redirect_stdout, redirect_stderr

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import usage_indicators as ui  # noqa: E402

try:
    from tempfile import TemporaryDirectory
except ImportError:  # pragma: no cover - stdlib, always present on 3.x
    raise


def write(root, rel_path, content):
    full = os.path.join(root, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(content)


def local_day(ts):
    """The exact conversion load_rows uses, for building test expectations
    without hard-coding this machine's timezone offset."""
    return datetime.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().date().isoformat()


def line(request_id, ts, model, is_sidechain=False, input_tokens=1000, output_tokens=500,
         cache_read=1000, w5=1000, w1h=0, speed=None, geo=None):
    usage = {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read,
        "cache_creation": {"ephemeral_5m_input_tokens": w5, "ephemeral_1h_input_tokens": w1h},
    }
    if speed:
        usage["speed"] = speed
    if geo:
        usage["inference_geo"] = geo
    rec = {
        "type": "assistant",
        "requestId": request_id,
        "timestamp": ts,
        "isSidechain": is_sidechain,
        "message": {"model": model, "usage": usage},
    }
    import json
    return json.dumps(rec) + "\n"


class ProjectSlugResolution(unittest.TestCase):
    """P1, round 1: subagent transcripts nest at <slug>/<uuid>/subagents/*.jsonl;
    the slug must resolve correctly regardless of that extra nesting."""

    def test_nested_subagent_file_gets_correct_project_slug(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session-main.jsonl",
                  line("m1", "2026-09-24T10:00:00Z", "claude-opus-5", is_sidechain=False))
            write(root, "proj-a/sess-uuid-1/subagents/agent-1.jsonl",
                  line("s1", "2026-09-24T10:05:00Z", "claude-sonnet-5", is_sidechain=True))

            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(len(rows), 2)
            self.assertEqual({r["proj"] for r in rows}, {"proj-a"})

            # The bug this guards: filtering by the real slug used to drop
            # the nested subagent file because its resolved "proj" was the
            # literal string "subagents".
            rows2, _, _ = ui.load_rows(f"{root}/**/*.jsonl", None, "proj-a")
            self.assertEqual(len(rows2), 2)
            self.assertTrue(any(r["is_sidechain"] for r in rows2))

    def test_warning_fires_only_when_a_filter_eats_real_sidechain_data(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session-main.jsonl",
                  line("m1", "2026-09-24T10:00:00Z", "claude-opus-5", is_sidechain=False))
            write(root, "proj-a/sess-uuid-1/subagents/agent-1.jsonl",
                  line("s1", "2026-09-24T10:05:00Z", "claude-sonnet-5", is_sidechain=True))

            err = StringIO()
            with redirect_stderr(err):
                rows, _, _ = ui.load_rows(f"{root}/**/*.jsonl", None, "proj-nonexistent")
            self.assertEqual(len(rows), 0)
            self.assertIn("WARNING", err.getvalue())
            self.assertIn("ZERO isSidechain", err.getvalue())

            err2 = StringIO()
            with redirect_stderr(err2):
                rows2, _, _ = ui.load_rows(f"{root}/**/*.jsonl", None, "proj-a")
            self.assertEqual(len(rows2), 2)
            self.assertEqual(err2.getvalue(), "")


class DedupKeepsMaxOutput(unittest.TestCase):
    """P2, round 1: streaming lines share a requestId with growing
    output_tokens; only the max is the real total."""

    def test_keeps_highest_output_tokens_for_duplicate_request_id(self):
        with TemporaryDirectory() as root:
            content = (
                line("dup1", "2026-09-24T10:05:00Z", "claude-opus-5", is_sidechain=True, output_tokens=2)
                + line("dup1", "2026-09-24T10:05:01Z", "claude-opus-5", is_sidechain=True, output_tokens=2)
                + line("dup1", "2026-09-24T10:05:02Z", "claude-opus-5", is_sidechain=True, output_tokens=873)
            )
            write(root, "proj-a/session.jsonl", content)
            rows, _, _ = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["output"], 873)

    def test_input_and_cache_read_do_not_change_across_duplicates(self):
        # Sanity check on the assumption the fix relies on: only output grows.
        with TemporaryDirectory() as root:
            content = (
                line("dup2", "2026-09-24T10:05:00Z", "claude-opus-5", output_tokens=2, input_tokens=999, cache_read=555)
                + line("dup2", "2026-09-24T10:05:01Z", "claude-opus-5", output_tokens=40, input_tokens=999, cache_read=555)
            )
            write(root, "proj-a/session.jsonl", content)
            rows, _, _ = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["output"], 40)
            self.assertEqual(rows[0]["input"], 999)
            self.assertEqual(rows[0]["cache_read"], 555)


class UnpricedModels(unittest.TestCase):
    """P2, round 1 + round 2: an unpriced model must not cost $0 silently,
    and must only be reported for the window it actually survives filtering
    into (round-2 finding: an earlier fix tallied it before filtering)."""

    def test_unpriced_model_flagged_and_excluded_from_cost(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl", line("u1", "2026-09-24T10:00:00Z", "claude-opus-6"))
            rows, unpriced, _ = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["cost"], 0.0)
            self.assertEqual(unpriced["claude-opus-6"], 1)

    def test_unpriced_model_not_reported_if_since_filters_it_out(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl", line("u1", "2026-09-24T10:00:00Z", "claude-opus-6"))
            rows, unpriced, _ = ui.load_rows(f"{root}/**/*.jsonl", "2099-01-01", None)
            self.assertEqual(len(rows), 0)
            self.assertEqual(dict(unpriced), {})


class LocalDayBucketing(unittest.TestCase):
    """P3, round 1: days and --since must use local time (.astimezone()),
    matching claude-usage-report.py, not raw UTC."""

    def test_day_matches_local_timezone_conversion(self):
        ts = "2026-09-24T23:30:00Z"
        expected_day = local_day(ts)
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl", line("t1", ts, "claude-sonnet-5"))
            rows, _, _ = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(rows[0]["day"], expected_day)

    def test_since_boundary_uses_the_same_local_day(self):
        ts = "2026-09-24T23:30:00Z"
        expected_day = local_day(ts)
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl", line("t1", ts, "claude-sonnet-5"))
            rows_incl, _, _ = ui.load_rows(f"{root}/**/*.jsonl", expected_day, None)
            self.assertEqual(len(rows_incl), 1)
            next_day = (datetime.date.fromisoformat(expected_day) + datetime.timedelta(days=1)).isoformat()
            rows_excl, _, _ = ui.load_rows(f"{root}/**/*.jsonl", next_day, None)
            self.assertEqual(len(rows_excl), 0)


class FastSpeedReprice(unittest.TestCase):
    """P3, round 1: a fast-speed reprice must use each model's own cache-read
    ratio, not a flat 10% -- claude-opus-5-5's real ratio is 5%."""

    def test_opus_5_5_fast_cache_read_uses_its_own_ratio(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl",
                  line("f1", "2026-09-24T10:00:00Z", "claude-opus-5-5",
                       speed="fast", input_tokens=1_000_000, output_tokens=0,
                       cache_read=1_000_000, w5=0, w1h=0))
            rows, _, _ = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            # FAST["claude-opus-5-5"] = (8, 40); real ratio pr/bi = 0.20/4 = 0.05
            # -> cache-read rate = 8 * 0.05 = 0.4 $/MTok -> $0.40 for 1M tokens.
            self.assertAlmostEqual(rows[0]["cost_read"], 0.40, places=6)

    def test_opus_5_fast_cache_read_unaffected(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl",
                  line("f2", "2026-09-24T10:00:00Z", "claude-opus-5",
                       speed="fast", input_tokens=1_000_000, output_tokens=0,
                       cache_read=1_000_000, w5=0, w1h=0))
            rows, _, _ = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            # FAST["claude-opus-5"] = (10, 50); real ratio pr/bi = 0.50/5 = 0.10
            # -> cache-read rate = 10 * 0.10 = 1.0 $/MTok -> $1.00 for 1M tokens.
            self.assertAlmostEqual(rows[0]["cost_read"], 1.00, places=6)


class OpusToSonnetCounterfactual(unittest.TestCase):
    """P3, round 1: the 0.4x counterfactual only applies to claude-opus-5;
    other Opus generations must be reported separately, not silently
    multiplied by the wrong ratio."""

    def test_unverified_opus_generation_excluded_from_flat_ratio(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl",
                  line("g1", "2026-09-24T10:00:00Z", "claude-opus-4-8", is_sidechain=True)
                  + line("g2", "2026-09-24T10:01:00Z", "claude-opus-5", is_sidechain=True))
            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            out = StringIO()
            with redirect_stdout(out):
                ui.report(rows, unpriced, diag)
            text = out.getvalue()
            self.assertIn("claude-opus-5 subagent spend at claude-sonnet-5 rates", text)
            self.assertIn("no verified exact Sonnet-equivalent ratio", text)
            self.assertIn("claude-opus-4-8", text)


class SubagentBreakdownReconciles(unittest.TestCase):
    """Round 2: indicator 4's Opus/Sonnet/other partition must sum to the
    subagent total -- an earlier version silently dropped Fable/Haiku."""

    def test_fable_and_haiku_appear_in_other_and_reconcile(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl",
                  line("h1", "2026-09-24T10:00:00Z", "claude-haiku-4-5", is_sidechain=True)
                  + line("h2", "2026-09-24T10:01:00Z", "claude-fable-5", is_sidechain=True)
                  + line("h3", "2026-09-24T10:02:00Z", "claude-opus-5", is_sidechain=True))
            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            sub_rows = [r for r in rows if r["is_sidechain"]]
            sub_cost = sum(r["cost"] for r in sub_rows)
            opus_cost = sum(r["cost"] for r in sub_rows if r["model"].startswith("claude-opus"))
            sonnet_cost = sum(r["cost"] for r in sub_rows if r["model"].startswith("claude-sonnet"))
            other_cost = sub_cost - opus_cost - sonnet_cost
            self.assertGreater(other_cost, 0)  # haiku + fable, both non-zero cost

            out = StringIO()
            with redirect_stdout(out):
                ui.report(rows, unpriced, diag)
            text = out.getvalue()
            self.assertIn("other (", text)
            self.assertIn("claude-haiku-4-5", text)
            self.assertIn("claude-fable-5", text)
            self.assertIn("reconciles to", text)


class SinceDateValidation(unittest.TestCase):
    """Round 2: --since must reject a partial or malformed date instead of
    silently widening or narrowing the window."""

    def test_valid_full_date_accepted(self):
        self.assertEqual(ui.valid_since_date("2026-09-24"), "2026-09-24")

    def test_partial_date_rejected(self):
        with self.assertRaises(Exception):
            ui.valid_since_date("2026-09")

    def test_unpadded_date_rejected(self):
        with self.assertRaises(Exception):
            ui.valid_since_date("2026-9-24")

    def test_garbage_rejected(self):
        with self.assertRaises(Exception):
            ui.valid_since_date("not-a-date")


class ScanDiagnostics(unittest.TestCase):
    """Round 2: silent skip paths (unreadable file, bad JSON, missing id,
    missing timestamp) must be counted and surfaced, not just absorbed."""

    def test_skip_counters_and_file_counts(self):
        import json
        with TemporaryDirectory() as root:
            good = line("ok1", "2026-09-24T10:00:00Z", "claude-opus-5")
            # Must still contain the substring '"usage"' -- the loop skips
            # lines without it cheaply, before ever attempting json.loads,
            # so a malformed line lacking that substring never reaches (and
            # therefore never counts against) the JSON-parse-error path.
            bad_json = '{"usage": this is not valid json\n'
            missing_id = json.dumps({
                "type": "assistant", "timestamp": "2026-09-24T10:00:00Z",
                "message": {"model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            }) + "\n"
            missing_ts = json.dumps({
                "type": "assistant", "requestId": "no-ts",
                "message": {"model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            }) + "\n"
            write(root, "proj-a/session.jsonl", good + bad_json + missing_id + missing_ts)

            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(len(rows), 1)
            self.assertEqual(diag["files_matched"], 1)
            self.assertEqual(diag["files_unreadable"], 0)
            self.assertEqual(diag["skipped_json_error"], 1)
            self.assertEqual(diag["skipped_missing_id"], 1)
            self.assertEqual(diag["skipped_missing_timestamp"], 1)

            out = StringIO()
            with redirect_stdout(out):
                ui.report(rows, unpriced, diag)
            text = out.getvalue()
            self.assertIn("scanned 1 files", text)
            self.assertIn("skipped 3 lines while parsing", text)
            self.assertIn("unparseable JSON", text)
            self.assertIn("missing a request id", text)
            self.assertIn("missing a timestamp", text)

    def test_filters_and_date_range_echoed(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl", line("ok1", "2026-09-24T10:00:00Z", "claude-opus-5"))
            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", "2026-09-24", "proj-a")
            out = StringIO()
            with redirect_stdout(out):
                ui.report(rows, unpriced, diag)
            text = out.getvalue()
            self.assertIn("--since=2026-09-24", text)
            self.assertIn("--project=proj-a", text)
            self.assertIn("date range actually covered", text)


class CacheWriteTierHypothetical(unittest.TestCase):
    """Round 2 (SKILL.md:129): indicator 5's dollar comparison must be
    reproducible from this window's own rows, and the all-5-minute
    hypothetical must equal actual spend when everything really is on the
    5-minute tier (a built-in sanity check on the calculation itself)."""

    def test_all_5_minute_hypothetical_equals_actual_when_nothing_used_1h(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl",
                  line("w1", "2026-09-24T10:00:00Z", "claude-opus-5", w5=100_000, w1h=0))
            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", None, None)

            # Test the invariant directly (not by grepping formatted dollar
            # strings, which round and are brittle): when 100% of writes are
            # actually on the 5-minute tier, the all-5-minute hypothetical
            # must equal actual spend exactly, and the all-1-hour
            # hypothetical must be strictly larger (2x base vs 1.25x base).
            priced_rows = [r for r in rows if r["_priced"]]
            actual = sum(r["cost_w5"] + r["cost_w1h"] for r in priced_rows)
            hyp_5m = sum((r["w5"] + r["w1h"]) * r["_p5_rate"] / 1e6 * r["_geo"] for r in priced_rows)
            hyp_1h = sum((r["w5"] + r["w1h"]) * r["_p1_rate"] / 1e6 * r["_geo"] for r in priced_rows)
            self.assertAlmostEqual(actual, hyp_5m, places=9)
            self.assertGreater(hyp_1h, hyp_5m)

            out = StringIO()
            with redirect_stdout(out):
                ui.report(rows, unpriced, diag)
            text = out.getvalue()
            self.assertIn("1-hour 0.0%", text)
            self.assertIn("actual cache-write spend", text)
            self.assertIn("hypothetical if ALL cache-write tokens", text)


if __name__ == "__main__":
    unittest.main()

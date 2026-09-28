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

These tests exist because four rounds of ugcportal-9ak's PR review found bugs
in usage_indicators.py that, overwhelmingly, look like good news instead of
an error (see that module's docstring). Round 1 found six; round 2 found
that the round-1 fix's own docstring claimed test coverage that didn't exist
yet (this file is what makes that claim true) plus five more, including a
subagent breakdown that silently dropped Fable/Haiku from its own total;
round 3 found seven more, including a model-id normalizer that only covered
two hardcoded date suffixes; round 4 found that round 3's OWN fixes had two
new bugs of their own (a glob_base_dir fallback that broke on a relative
glob, and an anomalies-ledger projection that could silently discard an
unlisted key -- the exact failure the ledger exists to prevent) plus a test
in this file that no-ops on this repo's own Python (3.9.6) rather than
covering the fix it claims to. Nothing in this repo's CI runs this file --
see SKILL.md and the bead tracking that gap -- so it is run by hand, and
must be run by hand before trusting a change to usage_indicators.py.
"""
import datetime
import os
import sys
import unittest
from io import StringIO
from contextlib import redirect_stdout, redirect_stderr
from unittest import mock

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


class ModelIdNormalization(unittest.TestCase):
    """Round 3, medium 1: norm_model must strip ANY 8-digit date suffix, not
    just the two hardcoded ones seen so far -- an unstripped suffix makes a
    real model look unpriced and its cost silently render as $0.00 while its
    request count stays nonzero (the third instance of this file's pricing
    gap rendering as a reassuring zero)."""

    def test_known_suffixes_still_stripped(self):
        self.assertEqual(ui.norm_model("claude-opus-5-20260401"), "claude-opus-5")
        self.assertEqual(ui.norm_model("claude-sonnet-5-20251001"), "claude-sonnet-5")

    def test_unseen_date_suffix_also_stripped(self):
        # The whole point of the regex fix: a date this file has never seen
        # before must normalize the same way as the two it happened to see.
        self.assertEqual(ui.norm_model("claude-opus-5-20260601"), "claude-opus-5")

    def test_model_with_previously_unstripped_suffix_now_prices_correctly(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl",
                  line("d1", "2026-09-24T10:00:00Z", "claude-opus-5-20260601", is_sidechain=True))
            rows, unpriced, _ = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(len(rows), 1)
            self.assertTrue(rows[0]["_priced"])
            self.assertGreater(rows[0]["cost"], 0)
            self.assertEqual(dict(unpriced), {})

    def test_inference_geo_bracket_still_stripped_alongside_date_suffix(self):
        self.assertEqual(ui.norm_model("claude-opus-5-20260601[1m]"), "claude-opus-5")


class GlobBaseDirResolution(unittest.TestCase):
    """Round 3: base_dir must be the deepest directory containing no glob
    metacharacter, not just the text before the first literal '*' --
    otherwise a narrowing glob with a '*' mid-component (e.g.
    "projects/ugc*/**/*.jsonl") makes every resolved project slug ".."."""

    def test_wildcard_at_component_boundary(self):
        self.assertEqual(
            ui.glob_base_dir("/x/y/.claude/projects/**/*.jsonl"),
            "/x/y/.claude/projects",
        )

    def test_wildcard_mid_component_narrowing_glob(self):
        self.assertEqual(
            ui.glob_base_dir("/x/y/.claude/projects/ugc*/**/*.jsonl"),
            "/x/y/.claude/projects",
        )

    def test_narrowing_glob_resolves_correct_project_slug(self):
        with TemporaryDirectory() as root:
            write(root, "ugcportal/session.jsonl",
                  line("n1", "2026-09-24T10:00:00Z", "claude-opus-5"))
            rows, _, _ = ui.load_rows(f"{root}/ugc*/*.jsonl", None, None)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["proj"], "ugcportal")

    def test_relative_pattern_falls_back_to_current_dir_not_filesystem_root(self):
        # Round 4 regression: when the metacharacter is in the FIRST path
        # component (a relative pattern like "*/*.jsonl"), base_parts ends
        # up empty, and `os.sep.join([]) or os.sep` fell back to "/" even
        # though the pattern was never absolute. os.path.relpath then
        # resolves every matched (relative) file against the filesystem
        # root instead of the current directory, so `proj` comes out as
        # the first component of the process's OWN cwd (e.g. "private" or
        # "home") for every row, and any --project filter matches nothing.
        self.assertEqual(ui.glob_base_dir("*/*.jsonl"), ".")
        self.assertEqual(ui.glob_base_dir("*.jsonl"), ".")

    def test_relative_pattern_resolves_correct_project_slug_end_to_end(self):
        with TemporaryDirectory() as root:
            write(root, "ugcportal/session.jsonl",
                  line("r1", "2026-09-24T10:00:00Z", "claude-opus-5"))
            cwd = os.getcwd()
            os.chdir(root)
            try:
                rows, _, _ = ui.load_rows("*/*.jsonl", None, "ugcportal")
            finally:
                os.chdir(cwd)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["proj"], "ugcportal")


class SinceDateValidation(unittest.TestCase):
    """Round 2: --since must reject a partial or malformed date instead of
    silently widening or narrowing the window. Round 3: it must also return
    the CANONICAL YYYY-MM-DD string, not whatever variant the caller typed
    -- on Python >= 3.11, date.fromisoformat itself accepts basic-format
    ("20260924") and ISO week-date ("2026-W40-1") strings, and returning
    those unchanged would silently break the plain string compare in
    load_rows on newer interpreters even though this validator "passed"."""

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

    def test_lenient_iso_variants_normalize_to_canonical_form_when_python_accepts_them(self):
        # Supplementary, real-world check: on an interpreter lenient enough
        # to accept these (Python >= 3.11), confirm the RETURNED value is
        # canonical rather than the raw input. This is NOT the test that
        # proves the fix -- on Python < 3.11 (this repo's own `python3` is
        # 3.9.6) date.fromisoformat rejects both inputs outright, so both
        # iterations skip via `continue` and the test passes vacuously,
        # having exercised nothing. See the white-box test below for the
        # one that actually holds on every version.
        import datetime as _dt
        for candidate in ("20260924", "2026-W40-1"):
            try:
                parsed = _dt.date.fromisoformat(candidate)
            except ValueError:
                continue  # this Python version doesn't accept it; nothing to check here
            self.assertEqual(ui.valid_since_date(candidate), parsed.isoformat())
            self.assertNotEqual(ui.valid_since_date(candidate), candidate)

    def test_returns_canonical_isoformat_not_the_raw_input_string(self):
        # THE test that actually proves the round-3 fix, on any Python
        # version. Round 4 found that the test above (relying on
        # date.fromisoformat's own version-dependent leniency to produce an
        # input whose accepted form differs from its canonical form) is a
        # no-op on this repo's interpreter (3.9.6): every string
        # date.fromisoformat accepts there is ALREADY exactly "YYYY-MM-DD",
        # so a passthrough bug (`return s`) and the correct fix
        # (`return d.isoformat()`) are indistinguishable on any real input
        # on that version -- mutation-verified: reverting to `return s`
        # left all tests green. Patching the parser itself to return a
        # controlled date, independent of what string was actually passed
        # or what any given Python version's parser would accept, makes the
        # CONTRACT ("call fromisoformat, return ITS OWN isoformat(), never
        # the verbatim input") observable everywhere, not just on 3.11+.
        fake_date = datetime.date(2026, 9, 24)
        with mock.patch.object(ui.datetime, "date") as mock_date_cls:
            mock_date_cls.fromisoformat.return_value = fake_date
            result = ui.valid_since_date("not-the-canonical-string")
        self.assertEqual(result, fake_date.isoformat())
        self.assertNotEqual(result, "not-the-canonical-string")


class ScanDiagnostics(unittest.TestCase):
    """Round 2 + round 3: every silent skip path (unreadable file, bad JSON,
    missing id, missing timestamp, non-assistant-with-usage-substring,
    non-dict usage, unrecognized model) must be counted in the single
    ANOMALY_KEYS ledger and surfaced unconditionally, never just absorbed."""

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
            # Round 3: three more silent paths, previously untallied.
            not_assistant = json.dumps({
                "type": "tool_result", "requestId": "not-asst",
                "timestamp": "2026-09-24T10:00:00Z",
                "note": "mentions usage elsewhere in its payload",
                "message": {"model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            }) + "\n"
            usage_not_dict = json.dumps({
                "type": "assistant", "requestId": "bad-usage",
                "timestamp": "2026-09-24T10:00:00Z",
                "message": {"model": "claude-opus-5", "usage": "not-a-dict"},
            }) + "\n"
            unrecognized_model = json.dumps({
                "type": "assistant", "requestId": "no-model",
                "timestamp": "2026-09-24T10:00:00Z",
                "message": {"model": None, "usage": {"input_tokens": 1, "output_tokens": 1}},
            }) + "\n"
            write(
                root, "proj-a/session.jsonl",
                good + bad_json + missing_id + missing_ts
                + not_assistant + usage_not_dict + unrecognized_model,
            )

            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(len(rows), 1)
            self.assertEqual(diag["files_matched"], 1)
            anomalies = diag["anomalies"]
            self.assertEqual(anomalies["files_unreadable"], 0)
            self.assertEqual(anomalies["lines_json_error"], 1)
            self.assertEqual(anomalies["lines_missing_id"], 1)
            self.assertEqual(anomalies["lines_missing_timestamp"], 1)
            self.assertEqual(anomalies["lines_not_assistant_with_usage"], 1)
            self.assertEqual(anomalies["lines_usage_not_dict"], 1)
            self.assertEqual(anomalies["lines_unrecognized_model"], 1)

            out = StringIO()
            with redirect_stdout(out):
                ui.report(rows, unpriced, diag)
            text = out.getvalue()
            self.assertIn("scanned 1 files", text)
            self.assertIn("anomalies across the WHOLE matched glob", text)
            for key in ui.ANOMALY_KEYS:
                self.assertIn(f"{key}: ", text)

    def test_anomalies_block_prints_even_when_everything_is_clean(self):
        # The chokepoint's whole point: zero anomalies must still be VISIBLE
        # as zero, not simply absent from the output -- absence and "checked,
        # found nothing" must not look the same.
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl", line("ok1", "2026-09-24T10:00:00Z", "claude-opus-5"))
            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            out = StringIO()
            with redirect_stdout(out):
                ui.report(rows, unpriced, diag)
            text = out.getvalue()
            self.assertIn("anomalies across the WHOLE matched glob", text)
            for key in ui.ANOMALY_KEYS:
                self.assertIn(f"{key}: 0", text)
            self.assertIn("unpriced_models (from the FILTERED rows below): {}", text)

    def test_dedup_and_filter_drops_are_tallied(self):
        # Round 4: lines_dedup_superseded, rows_since_filtered and
        # rows_project_filtered were four of the "still untallied" drop
        # paths named in round 4 review -- confirm each increments.
        # The THIRD line here is what actually exercises supersession: the
        # first line establishes "d1" with output=2, the second raises it
        # to 99 (that one is a normal update, not a supersession -- it
        # WINS), and only the third, output=5 <= 99, is the one that gets
        # dropped and must be tallied.
        with TemporaryDirectory() as root:
            dup = (
                line("d1", "2026-09-24T10:00:00Z", "claude-opus-5", output_tokens=2)
                + line("d1", "2026-09-24T10:00:01Z", "claude-opus-5", output_tokens=99)
                + line("d1", "2026-09-24T10:00:02Z", "claude-opus-5", output_tokens=5)
            )
            write(root, "proj-a/session.jsonl", dup)
            write(root, "proj-b/session.jsonl", line("d2", "2026-09-24T10:00:00Z", "claude-opus-5"))
            # A raw line with no "usage" substring at all -- the cheap
            # prefilter's own drop path.
            with open(os.path.join(root, "proj-a", "non_usage.jsonl"), "w", encoding="utf-8") as f:
                f.write('{"type": "user", "note": "no usage field here"}\n')

            _, _, diag_nofilter = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            self.assertEqual(diag_nofilter["anomalies"]["lines_dedup_superseded"], 1)
            self.assertGreater(diag_nofilter["anomalies"]["lines_no_usage_substring"], 0)

            _, _, diag_since = ui.load_rows(f"{root}/**/*.jsonl", "2099-01-01", None)
            self.assertEqual(diag_since["anomalies"]["rows_since_filtered"], 2)

            _, _, diag_proj = ui.load_rows(f"{root}/**/*.jsonl", None, "proj-a")
            self.assertEqual(diag_proj["anomalies"]["rows_project_filtered"], 1)

    def test_unexpected_anomaly_key_fails_loudly_instead_of_vanishing(self):
        # Round 4, the projection bug: {key: anomalies[key] for key in
        # ANOMALY_KEYS} silently discarded any key NOT in that list -- the
        # exact failure this ledger exists to prevent, just moved one level
        # up. load_rows now asserts the keys match and raises rather than
        # drop. Verified here by monkeypatching ANOMALY_KEYS down to a
        # subset that excludes a key a REAL record in this fixture will
        # actually increment (missing_id) -- a fixture that increments
        # nothing leaves `anomalies` empty, and an empty Counter is
        # trivially a subset of anything, which would make this test pass
        # vacuously without exercising the assertion at all.
        import json as _json
        with TemporaryDirectory() as root:
            missing_id = _json.dumps({
                "type": "assistant", "timestamp": "2026-09-24T10:00:00Z",
                "message": {"model": "claude-opus-5", "usage": {"input_tokens": 1, "output_tokens": 1}},
            }) + "\n"
            write(root, "proj-a/session.jsonl", missing_id)
            with mock.patch.object(ui, "ANOMALY_KEYS", ("files_unreadable",)):
                with self.assertRaises(RuntimeError):
                    ui.load_rows(f"{root}/**/*.jsonl", None, None)

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


class UnpricedNoteAppearsInline(unittest.TestCase):
    """Round 3, medium 1: an unpriced model's $0.00 must be flagged on the
    SAME line it appears on (indicator 4's Opus/Sonnet/other breakdown), not
    only in the top-of-report banner -- a reader looking at one partition
    line has no reason to scroll back up."""

    def test_unpriced_opus_row_flagged_on_its_own_breakdown_line(self):
        with TemporaryDirectory() as root:
            write(root, "proj-a/session.jsonl",
                  # Unpriced (unknown generation) but still groups under Opus
                  # by prefix -- this is the concrete case medium-1 named.
                  line("z1", "2026-09-24T10:00:00Z", "claude-opus-6", is_sidechain=True))
            rows, unpriced, diag = ui.load_rows(f"{root}/**/*.jsonl", None, None)
            out = StringIO()
            with redirect_stdout(out):
                ui.report(rows, unpriced, diag)
            text = out.getvalue()
            self.assertIn("of which Opus: $0.00 (1 reqs, 1 unpriced)", text)


if __name__ == "__main__":
    unittest.main()

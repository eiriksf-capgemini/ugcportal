# v0.7.0 sizing review: what predicts a bead's cost

Written for `ugcportal-2hwe` on 2026-10-15, the day v0.7.0 was cut (PR #246,
`cceaeac`), to answer Eirik's "are the beads too big or too small, and what
can we learn from this." Every figure carries its `n`. The process-error
catalogue is `ugcportal-fbng`, cited rather than repeated.

## 1. What was measured

**Snapshot.** `bd list --all --json`, run 2026-10-15 in the main checkout at
`origin/main` `cceaeac`, filtered to `metadata.released_in == "v0.7.0"`:
**68 beads**, all closed; `tokens_impl` on 57, `tokens_qa` on 47 (46 after
the dedupe below), both on 45, `tokens_impl_passes` on 58. Review-round
counts come from `node scripts/release-cost-report.mjs --releases
v0.6.0,v0.7.0 --beads <that file> --cache <dir> --json <out>`, which read the
round markers on every PR (59 beads with a count); PR sizes from `gh pr view
<n> --json additions,deletions,changedFiles` over the 59 PRs in the cohort's
`prs`; dependency edges from `bd dep list <id> --json` in both directions per
bead. The script that produced every figure is in the appendix.

**Totals.** `tokens_impl` 27,634,320 over 57 beads, median 301,340, max
4,410,532 (`6uc2`); `tokens_qa` 27,350,002 over 46, median 462,180; recorded
total 54,984,322, review share 50%; median total for a bead with both figures
878,614 (n=45). The CHANGELOG's v0.7.0 cost summary says 55,972,192 because
PR #201's review bill (987,870, identical `tokens_qa_r1..r6`) is recorded on
both `577s` and `zo8n`; this document counts it once, on `577s`, which also
carries the PR's `tokens_impl`.

**Caveats for everything below.** One release, one author; `tokens_impl` is
a sum of self-reported agent-run totals (five of 57 marked `~` in the beads'
notes). Beads sharing a PR (`#188`, `#201`, `#211`, `#215`, `#223`) are
excluded from the diff-size test. Every Spearman rho is printed beside the
two-tailed 5% critical value for its own `n` (0.256 at n=59, 0.288 at n=47,
0.308 at n=41 — the t-based value, see the appendix), and "below the floor"
means "not detectable at this n", not "proven absent"; about fifteen pairings
were tested, so one marginal pass is expected by chance. The bead's
2026-10-10 and 10-14 premise figures (n=20 and 29) are superseded by this
snapshot.

## 2. The three candidate predictors (K1)

### 2.1 Estimated tier and effort

| `model` | n | `tokens_impl` median | IQR | max | n | `tokens_qa` median | n | rounds median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| haiku | 3 | 46,400 | 5,000–46,400 | 60,000 | 0 | — | 2 | 1 |
| sonnet | 28 | 190,813 | 113,285–497,299 | 4,410,532 | 24 | 431,343 | 33 | 3 (IQR 2–6) |
| opus | 21 | 520,530 | 347,980–702,396 | 1,772,609 | 20 | 650,288 | 20 | 3 (IQR 2–5) |
| fable | 5 | 160,775 | 120,000–250,000 | 629,630 | 2 | 477,355 | 4 | 1.5 |

`model_effort` orders build cost the same way: low 49,835 (n=7), medium
164,052 (n=7), high 389,208 (n=34), xhigh 490,941 (n=9) — the two small
groups are too few to lean on; the high/xhigh step rests on 43 beads.

**Verdict: the tier predicts the typical build cost and nothing about the
tail.** The sonnet/opus median gap is 2.7x on `tokens_impl` (n=28/21) and
1.8x on total (676,528 vs 1,210,924; n=24/19) — the premise note's "21%" came
from a 19-bead subset and does not survive. But both tiers have a median of 3
review rounds (n=33/20), sonnet beads reached the six-round cap more often (9
of 33 vs 3 of 20), and the most expensive bead of the release is sonnet-tier
(`6uc2`, 5.86M) — as in v0.5.0 (`jsc`, 2.10M, `harness-cost-controls` §6).
The tier is also not independent of size: `tokens_impl` tracks additions
within sonnet (rho 0.81, n=24, floor 0.404) but not within opus (0.19, n=21,
floor 0.433), the signature of a tag that encodes "how much code" rather
than "how hard". Both releases built after the inheritance bug (`2tc`) was
fixed show the same ordering; v0.6.0 had 9 opus beads to compare
(`release-cost-v0.5.0-vs-v0.6.0.md` §4), v0.7.0 has 21.

### 2.2 Implementation passes and review rounds

| `tokens_impl_passes` | n | `tokens_impl` median | IQR | cost per pass, median |
|---|---:|---:|---:|---:|
| 1 | 19 | 114,841 | 60,000–187,654 | 114,841 |
| 2 | 14 | 324,660 | 190,443–404,347 | 162,330 |
| 3+ | 24 | 643,449 | 408,038–743,270 | 166,295 |

Spearman passes~`tokens_impl` 0.75 (n=57, floor 0.261). By marker rounds,
total cost (impl+qa) medians are 265,115 / 612,876 / 1,150,885 / 1,615,734
for 1 / 2 / 3 / 4+ rounds (n=4/15/11/15); rounds~total 0.82 (n=45, floor
0.294), rounds~`tokens_qa` 0.92 (n=46, floor 0.291), rounds~`tokens_impl`
0.64 (n=50, floor 0.279). The two counts are nearly the same variable: passes
equals rounds on 32 of 51 beads (rho 0.85), because a pass is the
implementation plus one fix pass per blocking round.

**Verdict: passes predict almost everything, and are not a prediction.**
Per-pass cost is roughly flat (115k–166k median; recorded later review rounds
median 166,378, n=96, against a round-1 median of 183,884, n=41), so cost is
close to *rounds times a constant* — a decomposition of the bill, known only
when the bill is. Of the attributes recorded on a bead *before* work, none
predicts rounds strongly, and one is marginal: the number of K criteria (rho
0.28, n=59, floor 0.256 — just past the 5% value, with about fifteen pairings
tested; it tracks `tokens_impl` more clearly, 0.46, n=57, floor 0.261).
Below the floor: additions (0.25, n=47, floor 0.288), files changed (0.07,
n=47), description length (0.22, n=59, floor 0.256); and no ordering by tier
(rounds median 3 vs 3, n=33/20), by `cc_scope` with n≥7 (design 3, n=13;
process 4.5, n=14; rights 3, n=7) or by `cc_type` (feat 3, n=17; fix 3,
n=23; docs 2, n=7). The one clear pre-close correlate is the implementation
window itself (hours from start to close, rho 0.44, n=59) — another outcome.

Where the cost sits: the 20 beads that ran four or more rounds carry
31,498,849 of the 54,984,322 recorded tokens (**57%**); the 12 at the cap
carry 36%; the 28 that finished in one or two rounds carry 20%.

### 2.3 Diff size

| additions (single, unshared PR) | n | `tokens_impl` median | IQR | rounds median |
|---|---:|---:|---:|---:|
| under 200 | 16 | 115,588 | 73,578–164,052 | 2 (n=15) |
| 200–599 | 9 | 370,378 | 289,263–505,895 | 2 (n=8) |
| 600–1,199 | 11 | 501,040 | 196,427–646,670 | 4 (n=11) |
| 1,200 and over | 13 | 555,338 | 490,941–743,270 | 3 (n=13) |

Spearman additions~`tokens_impl` 0.71 (n=49, floor 0.282),
files~`tokens_impl` 0.55 (n=49), additions~`tokens_qa` 0.39 (n=41, floor
0.308), additions~total 0.58 (n=41), additions~rounds 0.25 (n=47, floor
0.288, below).

**Verdict: the premise was wrong about this one.** "Diff size predicts
nothing" rested on four PRs (`#206` 11 files +774 → 187,654; `#207` 2 files
+712 → 1,697,387; `#208` 7 files +1,419 → 1,772,609; `#209` 17 files +1,210 →
4,410,532 — all reproduced). They are the *tail*. On 49 beads, additions
predict build cost about as well as the pass count does, and predict rounds no
better than anything else: a fair estimate of the first pass, none of how many
passes follow.

### 2.4 Summary

| Predictor | Known at dispatch? | Build cost | Review cost / rounds |
|---|---|---|---|
| Tier and effort | yes | orders medians (2.7x sonnet→opus, n=28/21) | no (rounds median 3 vs 3, n=33/20) |
| Diff size | roughly | rho 0.71 (n=49) | rho 0.39 (n=41) / 0.25 (n=47, below floor) |
| K criteria count | yes | rho 0.46 (n=57) | rho 0.28 (n=59, at the floor) |
| Passes or rounds | no | rho 0.75 (n=57) | rho 0.92 (n=46) |

## 3. Are the beads too big or too small? (K2)

Three tests that do not look at cost, each over the 68 beads. The text
sweeps are the three regexes in the appendix script's `sweeps` table (stems
open, case-insensitive), run over `notes` and `close_reason` (132 non-empty
fields, 472,561 bytes); the script prints every matched sentence, and the
counts below are what reading them yields, with the exclusions stated.

**Beads that needed splitting.** No cohort bead has a `.N` child anywhere in
the 471-bead database (`qnq9.11` is itself a child, split *out of* `qnq9.3`
before work started). The `split_or_rescope` regex matched 18 beads. Six are
products of, or parents in, a split made before pick-up (`vq3z`, `qfy9`,
`yzo7` from `74w`; `qnq9.11` from `qnq9.3`; `15r`, and `vlnn` split out of it
— created 2026-10-08 17:06, before `15r` started at 18:10); two were
re-scoped before pick-up by the `j5fl` premise audit (`hhjq`, `qnq9.11`); and
**two** changed scope mid-work — `xh4j` widened (three tests "not currently
in this bead's scope statement") and `yzo7` narrowed (per-item licence terms
descoped to `74w.1`). The other ten matches were excluded on reading: eight
use the words in another sense (`zbcs`, `hwpc`, `kssp`, `nffp`, `7g2o`,
`i7lr` — a split correction, concurrency group, call-site or test count;
`pgpq`, `x8ab` — whether a finding deserves "its own bead") and two record a
decision *not* to split (`44qs`; `l99p`'s adjacent finding, left unfiled).

**Criteria the implementer could not verify.** Rule: the bead's own record
says a K was not met, or could not be verified as written, when the PR was
first put up — whether the implementer or round 1 said so. The
`unverifiable` regex, over `notes`, `close_reason`, `acceptance_criteria` and
`tokens_qa_note`, matched 10 beads. Five meet the rule: `uo15` K4
(screenshots the brief forbade), `wz8w` K1 and K3 (not met as written, found
by round 1), `rj7y` K2 (not met for skew, found by round 1), `i7lr` K4
(signed-in half could not be verified, judged non-blocking), `6uc2` K1
(Chromium check passing by hand, not in CI, filed as `68rt`). The other five
were excluded on reading: in `a3hj`, `ryd`, `0dh5` and `ry6w` "UNVERIFIABLE"
is the `j5fl` premise audit's verdict on the bead's *premise* before work
started, and `7g2o`'s "unverified list" is the implementer's own identifier
list, not a criterion. **Five of 68.**

**PRs that absorbed adjacent work.** 5 of 59 PRs carry more than one cohort
bead (`#188`, `#201` — three parser faults in one script — `#211`, `#215`,
`#223`) and one folded in a follow-up during review (`fb32`'s proxy-CA
override — the `absorbed` regex matched 11 beads; `fb32` is the one
absorption, `ocbo`'s fold into `#215` is already among the five, and the
other nine use the words for filing decisions, a merge commit or a
description rewrite). Against that, the scope freeze sent work *out*: 104
`discovered-from` children hang off 38 cohort beads (206 edges read), 63 of
them from 34 parents created inside the parent's own window (child
`created_at` between parent `started_at` and `closed_at`, inclusive, no
slack); excluding the three beads whose job was to file beads (`j5fl`,
`7dtn`, `k06e`), 68 children from 35 parents, 62 of them in-window. Six
absorptions against 68 split-outs.

**Answer: neither.** The median bead was open 2.2 hours and shipped as one PR
carrying one bead's work; two scope statements in 68 moved mid-work, five
criteria outran their implementer, and adjacent work went to new beads ten
times more often than into the PR. The two beads the premise called "small by
any scope measure" (`z4nh`, `6uc2`) were correctly sized and ran to the cap
on review findings: `6uc2`'s passes 5–7 cost 726k, 737k and 744k for comment
deletions, a PR-body edit and one merge (`bd memories
resumed-agents-have-a-rising-cost-floor`).

## 4. What is strong enough to act on (K4)

- **Rounds carry the cost** — rho 0.82 with total (n=45); 57% of tokens in
  the 20 beads at four or more rounds; consistent with v0.6.0's per-round
  accounting (`release-cost-v0.5.0-vs-v0.6.0.md` §3). Act on it.
- **Tier and size predict the build, not the rounds.** Medium strength: n of
  21–49, one release, tier confounded with size. Budget the first pass with
  it; do not explain an outlier with it.
- **No strong dispatch-time predictor of rounds; one marginal one.** K-count
  at rho 0.28 (n=59) sits just past the 5% value (0.256) among about fifteen
  pairings tested — a weak signal to re-test on v0.8.0, not a rule. The null
  for everything else rules out a strong predictor, not a weak one.
- **The "21% tier gap" and "diff size predicts nothing" claims** did not
  survive going from 19–20 beads to 49–57 — the K4 failure mode inside this
  bead's own history.

## 5. Recommendation (K3)

**Keep estimating `model` and `model_effort`.** They order build cost (low
49,835, n=7 → xhigh 490,941, n=9; the high/xhigh step on 43 beads) and, of
the fields set before work starts, they are the ones that tracked anything in
this cohort. Add no third field; re-tag no bead whose cost came from rounds.

**Stop** reading the release's most expensive bead as a tier mismatch (twice
a sonnet bead that attracted rounds), quoting tier gaps from under 30 beads,
and claiming diff size predicts nothing.

**Do not estimate rounds per bead.** No attribute available at dispatch
predicted them beyond a marginal K-count signal (rho 0.28, n=59), and a
guessed field would be read as a measurement. Rounds are driven by what
review finds — `fbng` records the chain cost ← passes ← findings ← prose —
and the data to test that chain is **not a field on any bead**: finding
*families* per round exist as prose, in PR verdicts and unevenly in
`tokens_qa_note`, and `release-cost-report.mjs` parses the verdicts with
known faults (`7w83`; the 121-count artefact reappears on `#201` round 4 and
`#187` round 1 in this run, so no mediums figure is used here).

**Collect that instead.** One metadata write per review round by the reviewer
already writing the verdict — `findings_rN="f1:3 f2:0 f3:1 f4:0 med:1 low:3"`
— one `bd update` per round, 60–150 writes a release at a few hundred tokens
each. It gives the v0.8.0 review the test this one could not run: whether
family-1 findings at round 1 predict rounds 4+, and whether the K-count
signal survives. If the first does, the lever is the pre-review claims audit,
not sizing.

**Plan v0.8.0 on the two robust numbers.** About 880k per bead with both
figures recorded (median, n=45); about a third of reviewed beads (20 of 59)
reaching four or more rounds and carrying 57% of the cost. Treat round 4 as
the trigger for the two measured reductions already in memory — a fresh agent
rather than a resumed one, deletion rather than rewriting of prose. Those act
on the variable that costs.

**Proposed CLAUDE.md wording** (model-fit section, replacing the paragraph
beginning "These are estimates, not measurements"; CLAUDE.md is
agent-edit-denied, so this is for Eirik to apply):

> These are estimates of the *build*, not of the bead. Measured on v0.7.0
> (`docs/process/sizing-review-v0.7.0-2026-10-15.md`): the tier orders
> `tokens_impl` medians (sonnet 191k, opus 521k; n=28/21) and `model_effort`
> orders them too (low 50k, n=7, to xhigh 491k, n=9), so the fields do their
> job for the first pass. They say nothing about review rounds — median 3 on
> both tiers (n=33/20) — and rounds are where the cost is: the 20 beads that
> went four or more rounds carried 57% of the release's recorded tokens, and
> the most expensive bead was sonnet-tier in v0.5.0 and v0.7.0 alike.
> Calibrate on medians per tier per release, not on individual beads: one
> sonnet bead costing more than every opus bead is a rounds story, and the fix
> is `review-standards` section 5 and the resumed-agent rule, not a re-tag.
> Do not add a per-bead rounds estimate: in v0.7.0 no attribute on a bead at
> dispatch predicted rounds beyond a marginal K-count signal (rho 0.28, n=59),
> which the v0.8.0 review re-tests before anyone plans on it.

## Appendix: reproducing the figures

Inputs, all gathered 2026-10-15 at `cceaeac`, into a scratch directory
outside the repository (`bd` runs in the main checkout; everything is written
to `/tmp/sizing-review`):

```bash
mkdir -p /tmp/sizing-review && cd /Users/eiriksf/code/ugcportal
bd list --all --json > /tmp/sizing-review/beads.json
IDS=$(node -e 'const a=JSON.parse(require("fs").readFileSync("/tmp/sizing-review/beads.json","utf8"));console.log(a.filter(b=>b.metadata?.released_in==="v0.7.0").map(b=>b.id).join(" "))')
for n in $(node -e 'const a=JSON.parse(require("fs").readFileSync("/tmp/sizing-review/beads.json","utf8"));const s=new Set();for(const b of a.filter(b=>b.metadata?.released_in==="v0.7.0"))for(const p of (b.metadata.prs||"").split(","))if(/gh-\d+/.test(p))s.add(p.trim().slice(3));console.log([...s].join(" "))'); do
  gh pr view $n --json number,additions,deletions,changedFiles --jq '[.number,.additions,.deletions,.changedFiles]|@tsv'; done > /tmp/sizing-review/prsizes.tsv
node scripts/release-cost-report.mjs --releases v0.6.0,v0.7.0 --beads /tmp/sizing-review/beads.json --cache /tmp/sizing-review/ghcache --json /tmp/sizing-review/costreport.json > /tmp/sizing-review/costreport.md
for id in $IDS; do for dir in up down; do bd dep list $id $([ $dir = up ] && echo --direction=up) --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s||"[]"))console.log(JSON.stringify({parent:process.argv[1],dir:process.argv[2],...e}))})' "$id" "$dir"; done; done > /tmp/sizing-review/deps.jsonl
```

Then, from `/tmp/sizing-review` with those four files (`beads.json`,
`prsizes.tsv`, `costreport.json`, `deps.jsonl`) beside it, the script below
prints every table, rho, floor, count and matched sentence quoted above
(medians and quartiles are of the recorded values; rho is Spearman with
average ranks for ties):

```js
import fs from "node:fs";
const all = JSON.parse(fs.readFileSync("beads.json", "utf8"));
const cohort = all.filter((b) => b.metadata?.released_in === "v0.7.0");
const sizes = Object.fromEntries(fs.readFileSync("prsizes.tsv", "utf8").trim().split("\n").map((l) => { const [n, add, del, files] = l.split("\t"); return [n, { add: +add, files: +files }]; }));
const rounds = Object.fromEntries(JSON.parse(fs.readFileSync("costreport.json", "utf8")).rows["v0.7.0"].map((r) => [r.id, r.rounds]));
const deps = fs.readFileSync("deps.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const num = (v) => (v == null || v === "" ? null : Number(v));
// Dedupe rule: two beads carrying an identical tokens_qa AND identical tokens_qa_rN keys for the same PR are one review bill; it is counted once, on the bead that also carries tokens_impl.
const qaKey = (b) => JSON.stringify([b.metadata.prs, b.metadata.tokens_qa, ...Object.keys(b.metadata).filter((k) => /^tokens_qa_r\d+$/.test(k)).sort().map((k) => k + "=" + b.metadata[k])]);
const seen = new Map(); const qaDuplicate = new Set();
for (const b of [...cohort].sort((a, b) => (b.metadata.tokens_impl ? 1 : 0) - (a.metadata.tokens_impl ? 1 : 0))) { if (b.metadata.tokens_qa == null) continue; const k = qaKey(b); if (seen.has(k)) qaDuplicate.add(b.id); else seen.set(k, b.id); }
console.log(`tokens_qa duplicates dropped: ${[...qaDuplicate].join(", ") || "none"}`);
const rows = cohort.map((b) => { const m = b.metadata, prs = (m.prs || "").split(",").map((s) => s.trim().replace("gh-", "")).filter(Boolean);
  return { id: b.id, tier: m.model, effort: m.model_effort, type: m.cc_type, scope: m.cc_scope, impl: num(m.tokens_impl), qa: qaDuplicate.has(b.id) ? null : num(m.tokens_qa), passes: num(m.tokens_impl_passes), rounds: rounds[b.id] ?? null,
    kCount: (b.acceptance_criteria || "").split("\n").filter((l) => /^K\d+:|^Following should never happen/.test(l)).length, descLen: (b.description || "").length,
    size: prs.length === 1 && sizes[prs[0]] && cohort.filter((o) => (o.metadata.prs || "").includes(`gh-${prs[0]}`)).length === 1 ? sizes[prs[0]] : null,
    hours: (Date.parse(b.closed_at) - Date.parse(b.started_at || b.created_at)) / 36e5, bead: b }; });
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
const rank = (xs) => { const s = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), r = []; for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
const rho = (pairs) => { const rx = rank(pairs.map((p) => p[0])), ry = rank(pairs.map((p) => p[1])), mx = rx.reduce((a, b) => a + b) / rx.length, my = ry.reduce((a, b) => a + b) / ry.length; let xy = 0, xx = 0, yy = 0; rx.forEach((x, i) => { xy += (x - mx) * (ry[i] - my); xx += (x - mx) ** 2; yy += (ry[i] - my) ** 2; }); return xy / Math.sqrt(xx * yy); };
// Two-tailed 5% critical value of Spearman's rho at this n, via t = rho*sqrt((n-2)/(1-rho^2)) and the Cornish-Fisher expansion of the t quantile (z = 1.959964).
const tCrit = (df) => { const z = 1.959964; return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3); };
const rhoCrit = (n) => { const t = tCrit(n - 2); return t / Math.sqrt(n - 2 + t * t); };
const table = (title, key, val, order) => { const g = {}; for (const r of rows) { const k = key(r), v = val(r); if (k != null && v != null) (g[k] ||= []).push(v); } console.log(`\n${title}`); for (const k of order ?? Object.keys(g).sort()) if (g[k]) console.log(`${k}: n=${g[k].length} median=${median(g[k])} IQR=${q(g[k], 0.25)}–${q(g[k], 0.75)} min=${Math.min(...g[k])} max=${Math.max(...g[k])}`); };
const sp = (label, pairs) => { const r = rho(pairs), c = rhoCrit(pairs.length); console.log(`${label}: rho=${r.toFixed(2)} n=${pairs.length} crit5%=${c.toFixed(3)} ${Math.abs(r) > c ? "above" : "below"} floor`); };
const total = (r) => (r.impl != null && r.qa != null ? r.impl + r.qa : null);
console.log(`cohort ${rows.length}; impl ${rows.filter((r) => r.impl != null).length}; qa ${rows.filter((r) => r.qa != null).length}; both ${rows.filter((r) => total(r) != null).length}; passes ${rows.filter((r) => r.passes != null).length}; rounds ${rows.filter((r) => r.rounds != null).length}`);
const sumOf = (f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
console.log(`tokens_impl sum=${sumOf((r) => r.impl)} median=${median(rows.filter((r) => r.impl != null).map((r) => r.impl))}; tokens_qa sum=${sumOf((r) => r.qa)} median=${median(rows.filter((r) => r.qa != null).map((r) => r.qa))}; total median (both)=${median(rows.filter((r) => total(r) != null).map(total))}; CHANGELOG-style total with the duplicate=${sumOf((r) => r.impl) + cohort.reduce((a, b) => a + (num(b.metadata.tokens_qa) ?? 0), 0)}`);
table("tier -> tokens_impl", (r) => r.tier, (r) => r.impl, ["haiku", "sonnet", "opus", "fable"]);
table("tier -> tokens_qa", (r) => r.tier, (r) => r.qa, ["haiku", "sonnet", "opus", "fable"]);
table("tier -> total", (r) => r.tier, total, ["haiku", "sonnet", "opus", "fable"]);
table("tier -> rounds", (r) => r.tier, (r) => r.rounds, ["haiku", "sonnet", "opus", "fable"]);
console.log(`at cap (>=6 rounds) by tier: ${["sonnet", "opus"].map((t) => `${t} ${rows.filter((r) => r.tier === t && r.rounds >= 6).length}/${rows.filter((r) => r.tier === t && r.rounds != null).length}`).join(", ")}`);
table("effort -> tokens_impl", (r) => r.effort, (r) => r.impl, ["low", "medium", "high", "xhigh"]);
table("passes -> tokens_impl", (r) => (r.passes == null ? null : r.passes >= 3 ? "3+" : String(r.passes)), (r) => r.impl, ["1", "2", "3+"]);
table("passes -> tokens_impl per pass", (r) => (r.passes == null ? null : r.passes >= 3 ? "3+" : String(r.passes)), (r) => (r.impl != null && r.passes ? r.impl / r.passes : null), ["1", "2", "3+"]);
table("rounds -> total", (r) => (r.rounds == null ? null : r.rounds >= 4 ? "4+" : String(r.rounds)), total, ["1", "2", "3", "4+"]);
table("cc_type -> rounds", (r) => r.type, (r) => r.rounds);
table("cc_scope -> rounds", (r) => r.scope, (r) => r.rounds);
const band = (r) => (r.size ? (r.size.add < 200 ? "<200" : r.size.add < 600 ? "200–599" : r.size.add < 1200 ? "600–1199" : "1200+") : null);
table("additions -> tokens_impl", band, (r) => r.impl, ["<200", "200–599", "600–1199", "1200+"]);
table("additions -> rounds", band, (r) => r.rounds, ["<200", "200–599", "600–1199", "1200+"]);
const pairs = (x, y, filter = () => true) => rows.filter((r) => x(r) != null && y(r) != null && filter(r)).map((r) => [x(r), y(r)]);
console.log("");
sp("passes~impl", pairs((r) => r.passes, (r) => r.impl)); sp("rounds~impl", pairs((r) => r.rounds, (r) => r.impl)); sp("rounds~qa", pairs((r) => r.rounds, (r) => r.qa)); sp("rounds~total", pairs((r) => r.rounds, total)); sp("passes~rounds", pairs((r) => r.passes, (r) => r.rounds));
sp("additions~impl", pairs((r) => r.size?.add, (r) => r.impl)); sp("files~impl", pairs((r) => r.size?.files, (r) => r.impl)); sp("additions~qa", pairs((r) => r.size?.add, (r) => r.qa)); sp("additions~total", pairs((r) => r.size?.add, total)); sp("additions~rounds", pairs((r) => r.size?.add, (r) => r.rounds)); sp("files~rounds", pairs((r) => r.size?.files, (r) => r.rounds));
for (const t of ["sonnet", "opus"]) sp(`additions~impl within ${t}`, pairs((r) => r.size?.add, (r) => r.impl, (r) => r.tier === t));
sp("kCount~rounds", pairs((r) => r.kCount, (r) => r.rounds)); sp("kCount~impl", pairs((r) => r.kCount, (r) => r.impl)); sp("kCount~total", pairs((r) => r.kCount, total)); sp("descLen~rounds", pairs((r) => r.descLen, (r) => r.rounds)); sp("hours~rounds", pairs((r) => r.hours, (r) => r.rounds));
console.log(`passes == rounds on ${rows.filter((r) => r.passes != null && r.rounds != null && r.passes === r.rounds).length} of ${rows.filter((r) => r.passes != null && r.rounds != null).length}; median hours open ${median(rows.map((r) => r.hours)).toFixed(1)}`);
const sum = (xs) => xs.reduce((a, r) => a + (r.impl ?? 0) + (r.qa ?? 0), 0), all$ = sum(rows);
for (const [label, f] of [["rounds>=6", (r) => r.rounds >= 6], ["rounds>=4", (r) => r.rounds >= 4], ["rounds<=2", (r) => r.rounds != null && r.rounds <= 2]]) { const xs = rows.filter(f); console.log(`${label}: ${xs.length} beads, ${sum(xs)} of ${all$} (${(100 * sum(xs) / all$).toFixed(0)}%)`); }
const perRound = []; for (const r of rows) if (r.qa != null) for (const [k, v] of Object.entries(r.bead.metadata)) { const m = k.match(/^tokens_qa_r(\d+)$/); if (m) perRound.push({ r: +m[1], v: Number(v) }); }
console.log(`recorded per-round review cost: round 1 median=${median(perRound.filter((p) => p.r === 1).map((p) => p.v))} n=${perRound.filter((p) => p.r === 1).length}; rounds 2+ median=${median(perRound.filter((p) => p.r > 1).map((p) => p.v))} n=${perRound.filter((p) => p.r > 1).length}`);
// --- section 3: scope tests ---
const ids = new Set(cohort.map((b) => b.id));
console.log(`\n.N children of cohort beads anywhere in ${all.length} beads: ${all.filter((b) => [...ids].some((i) => b.id.startsWith(i + "."))).map((b) => b.id).join(" ") || "none"}`);
const byId = Object.fromEntries(cohort.map((b) => [b.id, b]));
const children = deps.filter((d) => d.dir === "up" && d.dependency_type === "discovered-from");
const generators = new Set(["ugcportal-j5fl", "ugcportal-7dtn", "ugcportal-k06e"]);
// Window rule: child created_at >= parent started_at (created_at if never started) AND child created_at <= parent closed_at, both inclusive, no slack.
const inWindow = (d) => { const p = byId[d.parent], t = Date.parse(d.created_at); return t >= Date.parse(p.started_at || p.created_at) && t <= Date.parse(p.closed_at); };
const stat = (xs) => `${xs.length} children from ${new Set(xs.map((d) => d.parent)).size} parents`;
console.log(`dependency edges read: ${deps.length}; discovered-from children of cohort beads: ${stat(children)}; filed inside the parent's window: ${stat(children.filter(inWindow))}; excluding the bead-generating parents (${[...generators].map((g) => g.replace("ugcportal-", "")).join(", ")}): all ${stat(children.filter((d) => !generators.has(d.parent)))}, inside window ${stat(children.filter((d) => !generators.has(d.parent) && inWindow(d)))}`);
const prBeads = {}; for (const r of rows) for (const p of (r.bead.metadata.prs || "").split(",").map((s) => s.trim().replace("gh-", "")).filter(Boolean)) (prBeads[p] ||= []).push(r.id.replace("ugcportal-", ""));
console.log(`PRs: ${Object.keys(prBeads).length}; carrying more than one cohort bead: ${Object.entries(prBeads).filter(([, v]) => v.length > 1).map(([p, v]) => `#${p}=${v.join("+")}`).join(" ")}`);
// Text sweeps: notes and close_reason, case-insensitive, split into sentences; hits are printed and then READ -- the counts in section 3 are the reading, not the match count.
const fields = ["notes", "close_reason"];
const nonNull = cohort.flatMap((b) => fields.map((f) => b[f] || "")).filter(Boolean);
console.log(`sweep reach: ${cohort.length} beads x ${fields.join("+")} = ${nonNull.length} non-empty fields, ${nonNull.reduce((a, s) => a + Buffer.byteLength(s), 0)} bytes`);
// Stems are open (\w*) so "splitting", "re-scoped", "verify", "unverified", "unverifiable" all match; only the leading edge is anchored.
const sweeps = { split_or_rescope: /\b(split\w*|re-?scop\w*|descop\w*|moved to v0\.8|its own bead)/i, absorbed: /\b(fold\w* in(to)?|absorb\w*|fixed on (this|the same) PR)/i, unverifiable: /\b(not wired into CI|could not (be )?verif\w*|cannot be verif\w*|unverif\w*|not met|unmet)/i };
// The unverifiable-criteria sweep also reads acceptance_criteria and metadata.tokens_qa_note, where a K's own "Verified by" or the reviewer's note records the miss.
const fieldsFor = (name) => (name === "unverifiable" ? [...fields, "acceptance_criteria", "tokens_qa_note"] : fields);
const text = (b, f) => (f === "tokens_qa_note" ? b.metadata.tokens_qa_note : b[f]) || "";
for (const [name, re] of Object.entries(sweeps)) { const hits = new Set(); const lines = []; for (const b of cohort) for (const f of fieldsFor(name)) for (const s of text(b, f).split(/(?<=[.!?])\s+|\n+/)) if (re.test(s)) { hits.add(b.id); lines.push(`  ${b.id.replace("ugcportal-", "")}/${f}: ${s.replace(/\s+/g, " ").slice(0, 200)}`); } console.log(`\n${name} over ${fieldsFor(name).join("+")} ${re}: ${hits.size} beads matched\n${lines.join("\n")}`); }
```

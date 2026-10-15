# v0.7.0 sizing review: what predicts a bead's cost

Written for `ugcportal-2hwe` on 2026-10-15, the day v0.7.0 was cut (PR #246,
`cceaeac`), to answer Eirik's "are the beads too big or too small, and what
can we learn from this." Every figure carries its `n`. The process-error
catalogue is `ugcportal-fbng`, cited rather than repeated.

## 1. What was measured

**Snapshot.** `bd list --all --json`, run 2026-10-15 in the main checkout at
`origin/main` `cceaeac`, filtered to `metadata.released_in == "v0.7.0"`:
**68 beads**, all closed; `tokens_impl` on 57, `tokens_qa` on 47, both on 45,
`tokens_impl_passes` on 58. Review-round counts come from `node
scripts/release-cost-report.mjs --releases v0.6.0,v0.7.0 --beads <that file>
--cache <dir> --json <out>`, which read the round markers on every PR (59
beads with a count); PR sizes from `gh pr view <n> --json
additions,deletions,changedFiles` over the 59 PRs in the cohort's `prs`. The
script that produced every table is in the appendix.

**Totals** (matching the CHANGELOG's v0.7.0 cost summary): `tokens_impl`
27,634,320 over 57 beads, median 301,340, max 4,410,532 (`6uc2`); `tokens_qa`
28,337,872 over 47, median 477,698; recorded total 55,972,192, review share
51%; median total for a bead with both figures 878,614 (n=45).

**Caveats for everything below.** One release, one author; `tokens_impl` is
a sum of self-reported agent-run totals (five of 57 marked `~` in the beads'
notes). Beads sharing a PR (`#188`, `#201`, `#211`, `#215`, `#223`) are
excluded from the diff-size test. At n around 50 a Spearman rho under about
0.28 is inside the two-tailed 5% critical value for that n (0.279 in the
standard table), so "does not predict" means "not detectable at this n", not
"proven absent". The bead's 2026-10-10 and
10-14 premise figures (n=20 and 29) are superseded by this snapshot.

## 2. The three candidate predictors (K1)

### 2.1 Estimated tier and effort

| `model` | n | `tokens_impl` median | IQR | max | n | `tokens_qa` median | n | rounds median |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| haiku | 3 | 46,400 | 5,000–46,400 | 60,000 | 0 | — | 2 | 1 |
| sonnet | 28 | 190,813 | 113,285–497,299 | 4,410,532 | 25 | 441,784 | 33 | 3 (IQR 2–6) |
| opus | 21 | 520,530 | 347,980–702,396 | 1,772,609 | 20 | 650,288 | 20 | 3 (IQR 2–5) |
| fable | 5 | 160,775 | 120,000–250,000 | 629,630 | 2 | 477,355 | 4 | 1.5 |

`model_effort` orders build cost the same way: low 49,835 (n=7), medium
164,052 (7), high 389,208 (34), xhigh 490,941 (9).

**Verdict: the tier predicts the typical build cost and nothing about the
tail.** The sonnet/opus median gap is 2.7x on `tokens_impl` and 1.8x on total
(676,528 vs 1,210,924; n=24/19) — the premise note's "21%" came from a 19-bead
subset and does not survive. But both tiers have a median of 3 review rounds,
sonnet beads reached the six-round cap more often (9 of 33 vs 3 of 20), and
the most expensive bead of the release is sonnet-tier (`6uc2`, 5.86M) — as in
v0.5.0 (`jsc`, 2.10M, `harness-cost-controls` §6). The tier is also not
independent of size: `tokens_impl` tracks additions within sonnet (rho 0.81,
n=24) but not within opus (0.19, n=21), the signature of a tag that encodes
"how much code" rather than "how hard". v0.7.0 is the second release built
after the inheritance bug (`2tc`) was fixed — v0.6.0 was the first
(`release-cost-v0.5.0-vs-v0.6.0.md` §1) — so this is the first time the
comparison means much.

### 2.2 Implementation passes and review rounds

| `tokens_impl_passes` | n | `tokens_impl` median | IQR | cost per pass, median |
|---|---:|---:|---:|---:|
| 1 | 19 | 114,841 | 60,000–187,654 | 114,841 |
| 2 | 14 | 324,660 | 190,443–404,347 | 162,330 |
| 3+ | 24 | 643,449 | 408,038–743,270 | 166,295 |

Spearman passes~`tokens_impl` 0.75 (n=57). By marker rounds, total cost
(impl+qa) medians are 265,115 / 612,876 / 1,150,885 / 1,615,734 for 1 / 2 / 3 /
4+ rounds (n=4/15/11/15); rounds~total 0.82 (n=45), rounds~`tokens_qa` 0.92
(n=47), rounds~`tokens_impl` 0.64 (n=50). The two counts are nearly the same
variable: passes equals rounds on 32 of 51 beads (rho 0.85), because a pass
is the implementation plus one fix pass per blocking round.

**Verdict: passes predict almost everything, and are not a prediction.**
Per-pass cost is roughly flat (115k–166k median; recorded later review rounds
median 165,727, n=101, against a round-1 median of 183,268, n=42), so cost is
close to *rounds times a constant* — a decomposition of the bill, known only
when the bill is. Nothing recorded on a bead *before* work predicted it: tier
(both medians 3), additions (rho 0.25, n=47), files changed (0.07), number of
K criteria (0.28, n=59), description length (0.22), scope family (medians
2–4, n=7–19), `cc_type` (feat 3, fix 3, docs 2). Of the attributes tested,
the one correlate above the noise floor is the implementation window itself
(hours from start to close, rho 0.44, n=59) — another outcome.

Where the cost sits: the 20 beads that ran four or more rounds carry
32,486,719 of the 55,972,192 recorded tokens (**58%**); the 12 at the cap
carry 37%; the 28 that finished in one or two rounds carry 20%.

### 2.3 Diff size

| additions (single, unshared PR) | n | `tokens_impl` median | IQR | rounds median |
|---|---:|---:|---:|---:|
| under 200 | 16 | 115,588 | 73,578–164,052 | 2 (n=15) |
| 200–599 | 9 | 370,378 | 289,263–505,895 | 2 (n=8) |
| 600–1,199 | 11 | 501,040 | 196,427–646,670 | 4 (n=11) |
| 1,200 and over | 13 | 555,338 | 490,941–743,270 | 3 (n=13) |

Spearman additions~`tokens_impl` 0.71 (n=49), files~`tokens_impl` 0.55,
additions~`tokens_qa` 0.39 (n=41), additions~total 0.58 (n=41),
additions~rounds 0.25 (n=47).

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
| Tier and effort | yes | orders medians (2.7x sonnet→opus, n=28/21) | no (rounds median 3 vs 3) |
| Diff size | roughly | rho 0.71 (n=49) | rho 0.39 / 0.25 |
| Passes or rounds | no | rho 0.75 (n=57) | rho 0.92 (n=47) |

## 3. Are the beads too big or too small? (K2)

Three tests that do not look at cost, each over the 68 beads.

**Beads that needed splitting.** No cohort bead has a `.N` child anywhere in
the 471-bead database (`qnq9.11` is itself a child, split *out of* `qnq9.3`
before work started). Every sentence in the 68 beads' `notes` and
`close_reason` matching `split|re-?scope|descope|moved to v0.8|its own bead`
was read (26 beads matched; 204 fields, 572,437 bytes swept): four beads are
products of a split made before pick-up (`vq3z`, `qfy9`, `yzo7` from `74w`;
`qnq9.11`), one was re-scoped before pick-up (`hhjq`), and **one** had its
scope statement found short mid-work (`xh4j`: three tests "not currently in
this bead's scope statement"). The rest use the word in another sense.

**Criteria the implementer could not verify.** The regex `not wired into
CI|could not verify|cannot be verified|K\d.*(unmet|not met)` over the same
fields found two (`uo15` K4: screenshots the brief forbade; `rj7y` K2: not met
for skew, found by review); reading the `tokens_qa_note` and criteria of the
top-cost beads found two more (`i7lr` K4's signed-in half; `6uc2` K1's
Chromium check passing by hand, not in CI, filed as `68rt`). **Four of 68.**

**PRs that absorbed adjacent work.** 5 of 59 PRs carry more than one cohort
bead (`#188`, `#201` — three parser faults in one script — `#211`, `#215`,
`#223`) and one folded in a follow-up during review (`fb32`'s proxy-CA
override). Against that, the scope freeze sent work *out*: 104
`discovered-from` children hang off 38 cohort beads (206 edges, `bd dep list
<id> --json` and `--direction=up` per bead), 94 filed inside the parent's own
start-to-close window; excluding the three beads whose job was to file beads
(`j5fl`, `7dtn`, `k06e`), 65 children from 34 parents. Six absorptions
against 65 split-outs.

**Answer: neither.** The median bead was open 2.2 hours and shipped as one PR
carrying one bead's work; one scope statement in 68 was short, four criteria
outran their implementer, and adjacent work went to new beads ten times more
often than into the PR. The two beads the premise called "small by any scope
measure" (`z4nh`, `6uc2`) were correctly sized and ran to the cap on review
findings: `6uc2`'s passes 5–7 cost 726k, 737k and 744k for comment deletions,
a PR-body edit and one merge (`bd memories
resumed-agents-have-a-rising-cost-floor`).

## 4. What is strong enough to act on (K4)

- **Rounds carry the cost** — rho 0.82 with total (n=45); 58% of tokens in
  the 20 beads at four or more rounds; consistent with v0.6.0's per-round
  accounting (`release-cost-v0.5.0-vs-v0.6.0.md` §3). Act on it.
- **Tier and size predict the build, not the rounds.** Medium strength: n of
  21–49, one release, tier confounded with size. Budget the first pass with
  it; do not explain an outlier with it.
- **Nothing on a bead at dispatch predicts rounds.** A null result at n≈50
  rules out a strong predictor, not a weak one. It needs another release and
  better data (below) before "unpredictable" replaces "not detectable".
- **The "21% tier gap" and "diff size predicts nothing" claims** did not
  survive going from 19–20 beads to 49–57 — the K4 failure mode inside this
  bead's own history.

## 5. Recommendation (K3)

**Keep estimating `model` and `model_effort`.** They order build cost (low
50k → xhigh 491k) and, of the fields set before work starts, they are the
ones that tracked anything in this cohort. Add no third field; re-tag no bead
whose cost came from rounds.

**Stop** reading the release's most expensive bead as a tier mismatch (twice
a sonnet bead that attracted rounds), quoting tier gaps from under 30 beads,
and claiming diff size predicts nothing.

**Do not estimate rounds per bead.** Nothing available at dispatch predicted
them, and a guessed field would be read as a measurement. Rounds are driven by
what review finds — `fbng` records the chain cost ← passes ← findings ← prose
— and the data to test that chain is **not a field on any bead**: finding
*families* per round exist as prose, in PR verdicts and unevenly in
`tokens_qa_note`, and `release-cost-report.mjs` parses the verdicts with
known faults (`7w83`; the 121-count artefact reappears on `#201` round 4 and
`#187` round 1 in this run, so no mediums figure is used here).

**Collect that instead.** One metadata write per review round by the reviewer
already writing the verdict — `findings_rN="f1:3 f2:0 f3:1 f4:0 med:1 low:3"`
— one `bd update` per round, 60–150 writes a release at a few hundred tokens
each. It gives the v0.8.0 review the test this one could not run: whether
family-1 findings at round 1 predict rounds 4+. If they do, the lever is the
pre-review claims audit, not sizing.

**Plan v0.8.0 on the two robust numbers.** About 880k per bead with both
figures recorded (median, n=45); about a third of reviewed beads (20 of 59)
reaching four or more rounds and carrying 58% of the cost. Treat round 4 as
the trigger for the two measured reductions already in memory — a fresh agent
rather than a resumed one, deletion rather than rewriting of prose. Those act
on the variable that costs.

**Proposed CLAUDE.md wording** (model-fit section, replacing the paragraph
beginning "These are estimates, not measurements"; CLAUDE.md is
agent-edit-denied, so this is for Eirik to apply):

> These are estimates of the *build*, not of the bead. Measured on v0.7.0
> (`docs/process/sizing-review-v0.7.0-2026-10-15.md`): the tier orders
> `tokens_impl` medians (sonnet 191k, opus 521k; n=28/21) and `model_effort`
> orders them too (low 50k to xhigh 491k), so the fields do their job for the
> first pass. They say nothing about review rounds — median 3 on both tiers —
> and rounds are where the cost is: the 20 beads that went four or more rounds
> carried 58% of the release's recorded tokens, and the most expensive bead was
> sonnet-tier in v0.5.0 and v0.7.0 alike. Calibrate on medians per tier per
> release, not on individual beads: one sonnet bead costing more than every
> opus bead is a rounds story, and the fix is `review-standards` section 5 and
> the resumed-agent rule, not a re-tag. Do not add a per-bead rounds estimate;
> nothing recorded on a bead at dispatch predicted rounds in v0.7.0.

## Appendix: reproducing the figures

Inputs, all gathered 2026-10-15 at `cceaeac`. `beads.json`, `prsizes.tsv`,
`costreport.json`/`.md` and `ghcache/` are working files the commands below
create in the current directory; none is in the repository:

```bash
cd /Users/eiriksf/code/ugcportal && bd list --all --json > beads.json
# bead -> PR list, then one gh call per PR
for n in $(node -e 'const a=JSON.parse(require("fs").readFileSync("beads.json","utf8"));const s=new Set();for(const b of a.filter(b=>b.metadata?.released_in==="v0.7.0"))for(const p of (b.metadata.prs||"").split(","))if(/gh-\d+/.test(p))s.add(p.trim().slice(3));console.log([...s].join(" "))'); do
  gh pr view $n --json number,additions,deletions,changedFiles --jq '[.number,.additions,.deletions,.changedFiles]|@tsv'; done > prsizes.tsv
node scripts/release-cost-report.mjs --releases v0.6.0,v0.7.0 --beads beads.json --cache ghcache --json costreport.json > costreport.md
for id in <the 68 ids>; do bd dep list $id --direction=up --json; bd dep list $id --json; done   # one JSON array per call; tag each record with the bead and direction
```

Then, with those four files beside it, the script below prints every table and
rho quoted above (medians and quartiles are of the recorded values; rho is
Spearman with average ranks for ties):

```js
import fs from "node:fs";
const all = JSON.parse(fs.readFileSync("beads.json", "utf8"));
const cohort = all.filter((b) => b.metadata?.released_in === "v0.7.0");
const sizes = Object.fromEntries(fs.readFileSync("prsizes.tsv", "utf8").trim().split("\n").map((l) => { const [n, add, del, files] = l.split("\t"); return [n, { add: +add, files: +files }]; }));
const rounds = Object.fromEntries(JSON.parse(fs.readFileSync("costreport.json", "utf8")).rows["v0.7.0"].map((r) => [r.id, r.rounds]));
const num = (v) => (v == null || v === "" ? null : Number(v));
const rows = cohort.map((b) => { const m = b.metadata, prs = (m.prs || "").split(",").map((s) => s.trim().replace("gh-", "")).filter(Boolean);
  return { id: b.id, tier: m.model, effort: m.model_effort, type: m.cc_type, scope: m.cc_scope, impl: num(m.tokens_impl), qa: num(m.tokens_qa), passes: num(m.tokens_impl_passes), rounds: rounds[b.id] ?? null,
    kCount: (b.acceptance_criteria || "").split("\n").filter((l) => /^K\d+:|^Following should never happen/.test(l)).length, descLen: (b.description || "").length,
    size: prs.length === 1 && sizes[prs[0]] && cohort.filter((o) => (o.metadata.prs || "").includes(`gh-${prs[0]}`)).length === 1 ? sizes[prs[0]] : null,
    hours: (Date.parse(b.closed_at) - Date.parse(b.started_at || b.created_at)) / 36e5 }; });
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor(p * (xs.length - 1))];
const rank = (xs) => { const s = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), r = []; for (let i = 0; i < s.length;) { let j = i; while (j + 1 < s.length && s[j + 1][0] === s[i][0]) j++; for (let k = i; k <= j; k++) r[s[k][1]] = (i + j) / 2 + 1; i = j + 1; } return r; };
const rho = (pairs) => { const rx = rank(pairs.map((p) => p[0])), ry = rank(pairs.map((p) => p[1])), mx = rx.reduce((a, b) => a + b) / rx.length, my = ry.reduce((a, b) => a + b) / ry.length; let xy = 0, xx = 0, yy = 0; rx.forEach((x, i) => { xy += (x - mx) * (ry[i] - my); xx += (x - mx) ** 2; yy += (ry[i] - my) ** 2; }); return xy / Math.sqrt(xx * yy); };
const table = (title, key, val, order) => { const g = {}; for (const r of rows) { const k = key(r), v = val(r); if (k != null && v != null) (g[k] ||= []).push(v); } console.log(`\n${title}`); for (const k of order ?? Object.keys(g).sort()) if (g[k]) console.log(`${k}: n=${g[k].length} median=${median(g[k])} IQR=${q(g[k], 0.25)}–${q(g[k], 0.75)} min=${Math.min(...g[k])} max=${Math.max(...g[k])}`); };
const sp = (label, pairs) => console.log(`${label}: rho=${rho(pairs).toFixed(2)} n=${pairs.length}`);
const total = (r) => (r.impl != null && r.qa != null ? r.impl + r.qa : null);
console.log(`cohort ${rows.length}; impl ${rows.filter((r) => r.impl != null).length}; qa ${rows.filter((r) => r.qa != null).length}; both ${rows.filter((r) => total(r) != null).length}; passes ${rows.filter((r) => r.passes != null).length}; rounds ${rows.filter((r) => r.rounds != null).length}`);
table("tier -> tokens_impl", (r) => r.tier, (r) => r.impl, ["haiku", "sonnet", "opus", "fable"]);
table("tier -> tokens_qa", (r) => r.tier, (r) => r.qa, ["haiku", "sonnet", "opus", "fable"]);
table("tier -> total", (r) => r.tier, total, ["haiku", "sonnet", "opus", "fable"]);
table("tier -> rounds", (r) => r.tier, (r) => r.rounds, ["haiku", "sonnet", "opus", "fable"]);
table("effort -> tokens_impl", (r) => r.effort, (r) => r.impl, ["low", "medium", "high", "xhigh"]);
table("passes -> tokens_impl", (r) => (r.passes == null ? null : r.passes >= 3 ? "3+" : String(r.passes)), (r) => r.impl, ["1", "2", "3+"]);
table("passes -> tokens_impl per pass", (r) => (r.passes == null ? null : r.passes >= 3 ? "3+" : String(r.passes)), (r) => (r.impl != null && r.passes ? r.impl / r.passes : null), ["1", "2", "3+"]);
table("rounds -> total", (r) => (r.rounds == null ? null : r.rounds >= 4 ? "4+" : String(r.rounds)), total, ["1", "2", "3", "4+"]);
table("additions -> tokens_impl", (r) => (r.size ? (r.size.add < 200 ? "<200" : r.size.add < 600 ? "200–599" : r.size.add < 1200 ? "600–1199" : "1200+") : null), (r) => r.impl, ["<200", "200–599", "600–1199", "1200+"]);
table("additions -> rounds", (r) => (r.size ? (r.size.add < 200 ? "<200" : r.size.add < 600 ? "200–599" : r.size.add < 1200 ? "600–1199" : "1200+") : null), (r) => r.rounds, ["<200", "200–599", "600–1199", "1200+"]);
const pairs = (x, y, filter = () => true) => rows.filter((r) => x(r) != null && y(r) != null && filter(r)).map((r) => [x(r), y(r)]);
sp("passes~impl", pairs((r) => r.passes, (r) => r.impl)); sp("rounds~impl", pairs((r) => r.rounds, (r) => r.impl)); sp("rounds~qa", pairs((r) => r.rounds, (r) => r.qa)); sp("rounds~total", pairs((r) => r.rounds, total)); sp("passes~rounds", pairs((r) => r.passes, (r) => r.rounds));
sp("additions~impl", pairs((r) => r.size?.add, (r) => r.impl)); sp("files~impl", pairs((r) => r.size?.files, (r) => r.impl)); sp("additions~qa", pairs((r) => r.size?.add, (r) => r.qa)); sp("additions~total", pairs((r) => r.size?.add, total)); sp("additions~rounds", pairs((r) => r.size?.add, (r) => r.rounds)); sp("files~rounds", pairs((r) => r.size?.files, (r) => r.rounds));
for (const t of ["sonnet", "opus"]) sp(`additions~impl within ${t}`, pairs((r) => r.size?.add, (r) => r.impl, (r) => r.tier === t));
sp("kCount~rounds", pairs((r) => r.kCount, (r) => r.rounds)); sp("descLen~rounds", pairs((r) => r.descLen, (r) => r.rounds)); sp("hours~rounds", pairs((r) => r.hours, (r) => r.rounds));
console.log(`passes == rounds on ${rows.filter((r) => r.passes != null && r.rounds != null && r.passes === r.rounds).length} of ${rows.filter((r) => r.passes != null && r.rounds != null).length}`);
const sum = (xs) => xs.reduce((a, r) => a + (r.impl ?? 0) + (r.qa ?? 0), 0), all$ = sum(rows);
for (const [label, f] of [["rounds>=6", (r) => r.rounds >= 6], ["rounds>=4", (r) => r.rounds >= 4], ["rounds<=2", (r) => r.rounds != null && r.rounds <= 2]]) { const xs = rows.filter(f); console.log(`${label}: ${xs.length} beads, ${sum(xs)} of ${all$} (${(100 * sum(xs) / all$).toFixed(0)}%)`); }
```

The scope tests in section 3 are the `bd dep list` records above filtered to
`dependency_type == "discovered-from"`, with each child's `created_at`
compared to its parent's `started_at` and `closed_at`, and the three regexes
quoted in section 3 run over each cohort bead's `notes` and `close_reason`
split into sentences — the matched sentences were then read, not counted.

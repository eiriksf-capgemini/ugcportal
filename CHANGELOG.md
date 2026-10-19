# Changelog

## v0.9.0 - 2026-10-19

### 💰 Cost Summary

**Transcript cost (input-token equivalents)**

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 7,216,933 | 12,609,365 | 19,826,298 | 3/3 |
| 🐛 Fixes | 6,538,369 | 22,173,079 | 28,711,448 | 11/38 |
| 📝 Documentation | 3,188,619 | 7,100,344 | 10,288,963 | 10/34 |
| 🧪 Tests | 1,909,123 | 5,734,554 | 7,643,677 | 4/9 |
| 🏗️ Build & CI | 3,237,974 | 12,288,738 | 15,526,712 | 3/3 |
| 🔧 Chores | 14,371,433 | 25,389,328 | 39,760,761 | 6/7 |
| 🚫 Closed without a change | 107,691 | — | 107,691 | 1/3 |
| **Total** | **36,570,142** | **85,295,408** | **121,865,550** | **38/97** |

*Transcript cost is priced from local agent transcripts by `scripts/agent-pass-cost.mjs` in input-token equivalents: proportional to price only for a model priced at the standard ratios (two models whose cache read is cheaper are the exceptions), and a relative measure across models; it omits work done inline in an orchestrator session. The context-size table is each agent's final context window, not what it cost, and is not comparable with the first table or summable with it. A bead's figures can keep growing later from review on a follow-up fix without retroactively updating a past release — treat both as a lower bound, not the release's full or final cost.*

### ✨ Features

- **A configured user has no way to attest an upload that already exists, so their auto-published items can never become sellable** (`ugcportal-gkax`, scope: upload) — [#291](https://github.com/eiriksf-capgemini/ugcportal/pull/291)
- **Curation: store a free-text licence grant on a priced listing and show it to the buyer** (`ugcportal-74w.1`, scope: curation) — [#297](https://github.com/eiriksf-capgemini/ugcportal/pull/297)
- **The app sets no X-Frame-Options, frame-ancestors or Referrer-Policy header on any response** (`ugcportal-7ex5`, scope: security) — [#304](https://github.com/eiriksf-capgemini/ugcportal/pull/304)

### 🐛 Fixes

- **parameterCallSites accepts a parameter with a default initialiser, so the attestation guard's call-site link fails open; report the initialiser in problems (left when ugcportal-2k2q hit its pass budget)** (`ugcportal-pm4t`, scope: test-support) — [#306](https://github.com/eiriksf-capgemini/ugcportal/pull/306)
- **attestation-write-paths guard approves the media-upload write on a session-bound const the write never reads; link handleUpload's userId parameter to its call-site argument** (`ugcportal-y1tn`, scope: test-support) — [#306](https://github.com/eiriksf-capgemini/ugcportal/pull/306)
- **Nothing routes a .claude/agents change to a human, and check-sensitive-files' comment claims it does** (`ugcportal-lmsi`, scope: process) — [#299](https://github.com/eiriksf-capgemini/ugcportal/pull/299)
- **npm-audit gate: when one GHSA id appears at two severities, the printed (pkg, severity) token depends on vulnerabilities key order (left when ugcportal-1j4j's fourth pass hit review round 3)** (`ugcportal-eylm`, scope: ci) — [#326](https://github.com/eiriksf-capgemini/ugcportal/pull/326)
- **npm-audit gate prints an advisory's severity from the affected package's worst severity, and its stale-entry message says an id "no longer appears" when it still appears at moderate (left when ugcportal-1j4j hit its pass budget)** (`ugcportal-1aw4`, scope: ci) — [#326](https://github.com/eiriksf-capgemini/ugcportal/pull/326)
- **Lows batch S1: dispatch gate premise-fresh merge commits, mid-sentence premise mentions, git-failure wording in four copies, and a stale test comment (arfp, ze80, jtyl, itti)** (`ugcportal-zoee`, scope: process) — [#324](https://github.com/eiriksf-capgemini/ugcportal/pull/324)
- **Lows batch R1: release-cost-report clean/stated reading, addendum findings count, sibling line, and pr-review-merge step 4a item 5 to match (peom, rf5o, 45bh, oium, 4hsc, zu69)** (`ugcportal-to7b`, scope: review) — [#322](https://github.com/eiriksf-capgemini/ugcportal/pull/322)
- **Lows batch F1: cut-release 7a and review-standards section 1 bead snippets through quoted files, and the bd-guard test header (5q0a, cupf, 2xmq)** (`ugcportal-d7fm`, scope: process) — [#320](https://github.com/eiriksf-capgemini/ugcportal/pull/320)
- **Lows batch P2: check-human-merge-labels header, pr-review-merge step 2 and step 6 descriptions of it, and two missing guard tests (0n6h, 2ww3, lhak, rix6, 9uf5)** (`ugcportal-cafh`, scope: process) — [#317](https://github.com/eiriksf-capgemini/ugcportal/pull/317)
- **Lows batch P1: pr-review-merge merge step, BEHIND recovery and five stale prose claims (r8oq, 7998, slf2, s1t7, l6kd, 6do8, h46e)** (`ugcportal-c7q2`, scope: process) — [#312](https://github.com/eiriksf-capgemini/ugcportal/pull/312)
- **Lows batch V1: vitest config named export and two vitest comments (wcga, soa9)** (`ugcportal-sxsg`, scope: vitest) — [#311](https://github.com/eiriksf-capgemini/ugcportal/pull/311)
- **PR #299 body: pre-review checklist and K1 test line still say scripts are unchanged since the suite run, false after the round-4 commit d140ec6** (`ugcportal-hb3o`, scope: process) — [#299](https://github.com/eiriksf-capgemini/ugcportal/pull/299)
- **pr-review-merge step 2 companions: five prose defects left when ugcportal-lmsi hit its pass budget (PR #299 round 3)** (`ugcportal-8ii6`, scope: process) — [#299](https://github.com/eiriksf-capgemini/ugcportal/pull/299)
- **The Instagram callback builds its redirect from request.url while its two sibling admin routes use the configured origin** (`ugcportal-bawz`, scope: instagram) — [#314](https://github.com/eiriksf-capgemini/ugcportal/pull/314)
- **Ten of thirteen mutating API handlers rely on the SameSite cookie alone: the same-origin second lock covers only the three admin routes** (`ugcportal-qf9v`, scope: api) — [#305](https://github.com/eiriksf-capgemini/ugcportal/pull/305)
- **premise-fresh: two of the four "fails when" copies name the ancestry git-failure case and two do not (PR #289 round 7 L1)** (`ugcportal-itti`, scope: process) — [#324](https://github.com/eiriksf-capgemini/ugcportal/pull/324)
- **bindingsNamed sees only plain const/let/var declarations while its docstring says every binding** (`ugcportal-2k2q`, scope: test-support) — [#306](https://github.com/eiriksf-capgemini/ugcportal/pull/306)
- **premise-fresh lists a merge commit as having touched a declared path with no file named (PR #289 round 6 L2)** (`ugcportal-ze80`, scope: process) — [#324](https://github.com/eiriksf-capgemini/ugcportal/pull/324)
- **check-bead-dispatch test comment names the removed premiseCommits function (PR #289 round 5 L1)** (`ugcportal-arfp`, scope: process) — [#324](https://github.com/eiriksf-capgemini/ugcportal/pull/324)
- **Every vitest run prints a rolldown MIXED_EXPORTS warning because vitest.config.ts now has a named export beside its default export** (`ugcportal-wcga`, scope: vitest) — [#311](https://github.com/eiriksf-capgemini/ugcportal/pull/311)
- **Two inaccurate vitest comments from PR 295: ViteNodeRunner.globFiles does not exist, and "stricter than vitest 3" overlooks whitespace-only values** (`ugcportal-soa9`, scope: vitest) — [#311](https://github.com/eiriksf-capgemini/ugcportal/pull/311)
- **K3 late-attestation test only covers one of the route's 400 branches, so a Media write on the other 400 branch passes** (`ugcportal-dsp8`, scope: upload) — [#307](https://github.com/eiriksf-capgemini/ugcportal/pull/307)
- **pr-review-merge step 5 "first write this round makes" ignores the lock ref and the label removal, both writes that can precede the round comment** (`ugcportal-h46e`, scope: process) — [#312](https://github.com/eiriksf-capgemini/ugcportal/pull/312)
- **classifySeverity clean: approval-shape rule reads 15 genuine zero-finding rounds as not clean, unstated in the doc and over-stated in the P1 test title** (`ugcportal-rf5o`, scope: review) — [#322](https://github.com/eiriksf-capgemini/ugcportal/pull/322)
- **classifySeverity clean: "never clean" claim is false for a qualified no-findings opener, and "no blocking findings" is described as found-nothing** (`ugcportal-peom`, scope: review) — [#322](https://github.com/eiriksf-capgemini/ugcportal/pull/322)
- **classifySeverity: a "Verified, no finding:" sub-heading in a blocking verdict sets stated=true on the prose side** (`ugcportal-45bh`, scope: review) — [#322](https://github.com/eiriksf-capgemini/ugcportal/pull/322)
- **release-cost-report addenda merge medium/low/stated into a round but not the findings count, so the bare-count guard misses them** (`ugcportal-4hsc`, scope: review) — [#322](https://github.com/eiriksf-capgemini/ugcportal/pull/322)
- **pr-review-merge step 4a item 5: the #281 example names a stamp-write refusal, but #281's unstamped pass was a lock-write denial** (`ugcportal-oium`, scope: review) — [#322](https://github.com/eiriksf-capgemini/ugcportal/pull/322)
- **release-cost-report Data gaps sibling line says "the bead that carries the keys" on PRs where no bead carries keys** (`ugcportal-zu69`, scope: review) — [#322](https://github.com/eiriksf-capgemini/ugcportal/pull/322)
- **release-cost-report clean verdict line: comment says the summary regex reads the first line and SKILL.md says the line after the marker** (`ugcportal-tw9x`, scope: review) — [#285](https://github.com/eiriksf-capgemini/ugcportal/pull/285)
- **bd-guard.test.mjs header says every case runs the real CLI, but the five fixture-loader cases do not** (`ugcportal-2xmq`, scope: process) — [#320](https://github.com/eiriksf-capgemini/ugcportal/pull/320)
- **dispatch-bead section 5 tells a fix agent to push with `git push origin HEAD:<branch>`, which bypasses the bot HTTPS push and the pre-push skip that section 2 and worker-implementer.md require** (`ugcportal-8570`, scope: process) — [#315](https://github.com/eiriksf-capgemini/ugcportal/pull/315)
- **pr-review-merge BEHIND recovery poll treats a failed gh pr view as a changed head and stops as sha not fetched** (`ugcportal-7998`, scope: process) — [#312](https://github.com/eiriksf-capgemini/ugcportal/pull/312)
- **pr-review-merge step 6 report list and merge-failure paragraph omit the new CLEAN head-mismatch and match-head-commit refusal stops** (`ugcportal-s1t7`, scope: process) — [#312](https://github.com/eiriksf-capgemini/ugcportal/pull/312)
- **pr-review-merge BEHIND rationale says a kept file makes step 4.2 take its fail-safe branch, which is not what 4.2 does** (`ugcportal-r8oq`, scope: process) — [#312](https://github.com/eiriksf-capgemini/ugcportal/pull/312)
- **cut-release step 7a bead snippet single-quotes model_why in --metadata and builds the title from an inline heredoc; both run code on an apostrophe or an unbalanced parenthesis** (`ugcportal-5q0a`, scope: process) — [#320](https://github.com/eiriksf-capgemini/ugcportal/pull/320)
- **review-standards section 1 still files review-discovered beads in the bare-finding form (title heredoc, --body-file -), the unformed-bead source nr72 fixes only in pr-review-merge** (`ugcportal-cupf`, scope: process) — [#320](https://github.com/eiriksf-capgemini/ugcportal/pull/320)
- **pr-review-merge merge step still falls back to --merge, which the main ruleset refuses (squash and rebase only)** (`ugcportal-slf2`, scope: process) — [#312](https://github.com/eiriksf-capgemini/ugcportal/pull/312)

### 📝 Documentation

- **Lows batch D1: dispatch-bead section 5 fix-agent worktree, push and idle text, and the existing-branch worktree form in the worker machine sections (hvda, m7bh, 8570, 88up, 2day)** (`ugcportal-6c4p`, scope: process) — [#315](https://github.com/eiriksf-capgemini/ugcportal/pull/315)
- **Lows batch A1: three figures in architecture-review-2026-10-18 (flq1, 9dem, vfmc)** (`ugcportal-d6si`, scope: architecture) — [#310](https://github.com/eiriksf-capgemini/ugcportal/pull/310)
- **PR #306 body, Fifth pass K2: attestation-write-paths.test.ts:642 is placed "in the other test" but sits in the same test as the call-site link** (`ugcportal-hi8m`, scope: test-support) — [#306](https://github.com/eiriksf-capgemini/ugcportal/pull/306)
- **Two stale pointers left by PR #299's review: development-process.md names the removed CI job guard-sensitive-files, and pr-review-merge step 2 cites a scripts/lib/dashboard-data.mjs that does not exist** (`ugcportal-33xi`, scope: process) — [#309](https://github.com/eiriksf-capgemini/ugcportal/pull/309)
- **PR #302 body K3 bullet: rights-system-review-2026-10-12 citations are said to be in "the header, sections 1, 4, 9 and 10"; the grep it names returns none in section 10** (`ugcportal-ddqe`, scope: architecture) — [#302](https://github.com/eiriksf-capgemini/ugcportal/pull/302)
- **architecture-review-2026-10-18.md section 5: "every admin action calls requireAdmin (the security review's 3.9 drove all four)" reads as four admin actions; there are five, changeUserRole included** (`ugcportal-vfmc`, scope: architecture) — [#310](https://github.com/eiriksf-capgemini/ugcportal/pull/310)
- **architecture-review-2026-10-18.md section 4.3: the isPublishOperator row counts 2 files but names only the preview route; the second is publish-authority.ts's own call inside publishOperatorRefusal** (`ugcportal-9dem`, scope: architecture) — [#310](https://github.com/eiriksf-capgemini/ugcportal/pull/310)
- **architecture-review-2026-10-18.md section 3.1: "field-level @unique" is reported as 18, but grep -c '@unique' also counts the 4 @@unique lines; field-level is 14** (`ugcportal-flq1`, scope: architecture) — [#310](https://github.com/eiriksf-capgemini/ugcportal/pull/310)
- **PR #303 body defines "prisma CLI family" two ways: Summary excludes engines-version, the K2 grouping includes it** (`ugcportal-8blu`, scope: deps) — [#303](https://github.com/eiriksf-capgemini/ugcportal/pull/303)
- **Register stale-note names only the vitest row, but the prisma row's Installed cell (7.10.0) is stale since PR #303 moved prisma to 7.10.1** (`ugcportal-nexj`, scope: deps) — [#327](https://github.com/eiriksf-capgemini/ugcportal/pull/327)
- **PR #303 body Summary lists the register changes without the round-4 "Stale since this snapshot" note** (`ugcportal-c5re`, scope: deps) — [#303](https://github.com/eiriksf-capgemini/ugcportal/pull/303)
- **PR #300 body: round-4 evidence is stale (suite line numbers from 94bc974; checklist item 4 not re-run over the round-4 comment lines)** (`ugcportal-exsm`, scope: review) — [#300](https://github.com/eiriksf-capgemini/ugcportal/pull/300)
- **PR #305 body reports the three affected test files as 56/56; they hold 89 tests (50 + 29 + 10)** (`ugcportal-l3ca`, scope: api) — [#305](https://github.com/eiriksf-capgemini/ugcportal/pull/305)
- **siteOrigin doc says isSameOriginRequest falls back to an Origin/Host header and sits above it; it does neither** (`ugcportal-vbrb`, scope: api) — [#319](https://github.com/eiriksf-capgemini/ugcportal/pull/319)
- **origin.ts header says requireAdmin is the first gate on the admin routes, but the alcohol brand route's gate is requireAdminAccess** (`ugcportal-bq9g`, scope: api) — [#318](https://github.com/eiriksf-capgemini/ugcportal/pull/318)
- **Register "Patch moves taken" and PR #303 body: the stayed-at-7.10.0 list misses two packages, and four body sentences misstate the move; left when ugcportal-90i5 hit its pass budget** (`ugcportal-umox`, scope: deps) — [#303](https://github.com/eiriksf-capgemini/ugcportal/pull/303)
- **recordClearance docstring says the clearance reason is the one piece of free text on the curation screen, but the licence-terms textarea is a second** (`ugcportal-wk6t`, scope: curation) — [#301](https://github.com/eiriksf-capgemini/ugcportal/pull/301)
- **env.example says ADMIN_BOOTSTRAP_EMAILS is matched against the address stored on the User row; the code and a later paragraph of the same file say the asserted address** (`ugcportal-42yh`, scope: auth) — [#313](https://github.com/eiriksf-capgemini/ugcportal/pull/313)
- **A mangled tripwire comment in media/route.test.ts and the unfixed "node environment with no DOM" sentence in alt-text.ts and tag-selection.ts** (`ugcportal-sd96`, scope: upload) — [#323](https://github.com/eiriksf-capgemini/ugcportal/pull/323)
- **declarationsNamed docblock and test title claim "every shape" and "any binding shape" for a scan that reads four declaration kinds** (`ugcportal-uj69`, scope: upload) — [#316](https://github.com/eiriksf-capgemini/ugcportal/pull/316)
- **check-human-merge-labels header says the non-counting stops are not labelled where step 2's precedence labels a sensitive-path reviewed-clean one** (`ugcportal-2ww3`, scope: process) — [#317](https://github.com/eiriksf-capgemini/ugcportal/pull/317)
- **pr-review-merge step 6 says step 4b's counter keeps only the reviewer's markers where step 4b reads a foreign marker as a broken chain** (`ugcportal-lhak`, scope: process) — [#317](https://github.com/eiriksf-capgemini/ugcportal/pull/317)
- **pr-review-merge step 2 points at step 5b for the 7+ conditions and says the check lists a stop-comment label as C unconditionally** (`ugcportal-0n6h`, scope: process) — [#317](https://github.com/eiriksf-capgemini/ugcportal/pull/317)
- **pr-review-merge step 2 record says 3 to 19 seconds where #285 was labelled 2 seconds after opening** (`ugcportal-l6kd`, scope: process) — [#312](https://github.com/eiriksf-capgemini/ugcportal/pull/312)
- **pr-review-merge step 4b says PR #131's only marker sits on a COMMENTED review, but #131 carries two markers** (`ugcportal-6do8`, scope: process) — [#312](https://github.com/eiriksf-capgemini/ugcportal/pull/312)
- **dispatch-bead section 5 says the idle figures recorded on 2026-10-16 overstated the transcript measure, but two of that day's lines understate it** (`ugcportal-m7bh`, scope: process) — [#315](https://github.com/eiriksf-capgemini/ugcportal/pull/315)
- **dispatch-bead section 5 measures idle only after the dispatch (fresh agent's startTs) and bans the orchestrator's clock, leaving no stated method for the idle figure the resume-or-fresh decision is taken on** (`ugcportal-88up`, scope: process) — [#315](https://github.com/eiriksf-capgemini/ugcportal/pull/315)
- **dispatch-bead section 5 says the detached worktree add is granted to reviewers and analysts but does not tell the brief to override a worker-implementer's own machine section, which today allows only the -b form** (`ugcportal-hvda`, scope: process) — [#315](https://github.com/eiriksf-capgemini/ugcportal/pull/315)
- **worker-*.md machine section gives only the -b worktree form, so a fresh fix agent following dispatch-bead section 5 cannot add a worktree on the PR's existing branch without contradicting its own agent file** (`ugcportal-2day`, scope: process) — [#315](https://github.com/eiriksf-capgemini/ugcportal/pull/315)
- **release-cost-report: withFindingsKeys docstring points at the wrong rule statement and, with item 5, omits the addendum clause (left when ugcportal-to7b hit its pass budget)** (`ugcportal-4an4`, scope: review) — [#322](https://github.com/eiriksf-capgemini/ugcportal/pull/322)
- **declarationsNamed docblock: the agreement clause is false for its own example, and the PR body quotes a phrase the file does not contain (left when ugcportal-uj69 hit its pass budget)** (`ugcportal-pjah`, scope: upload) — [#316](https://github.com/eiriksf-capgemini/ugcportal/pull/316)
- **Two prose claims in PR #306 overstate the scan tests and the call-site link (left when ugcportal-2k2q hit its pass budget a second time)** (`ugcportal-9olk`, scope: test-support) — [#306](https://github.com/eiriksf-capgemini/ugcportal/pull/306)
- **prisma-write-scan.ts module header says ONE SCANNER, TWO CALLERS while prismaModelWritesIn has four callers** (`ugcportal-6hpv`, scope: test-support) — [#321](https://github.com/eiriksf-capgemini/ugcportal/pull/321)
- **pr-review-merge line 561 points at 'step 5 line 517', which is blank; the rule it means now sits near line 854** (`ugcportal-29ki`, scope: process) — [#299](https://github.com/eiriksf-capgemini/ugcportal/pull/299)

### 🧪 Tests

- **Attestation guard's leak message still says the request may be read only by readJsonBody after #305 also permitted isSameOriginRequest** (`ugcportal-p5ep`, scope: api) — [#325](https://github.com/eiriksf-capgemini/ugcportal/pull/325)
- **next.config.test.ts pins the header entries but not the `/:path*` rule object: a has/missing condition leaves every response bare while the test stays green (PR #304 round 3 L1)** (`ugcportal-5o8q`, scope: security) — [#304](https://github.com/eiriksf-capgemini/ugcportal/pull/304)
- **playwright.config.ts hardcodes localhost:3000; take the e2e dev-server port from UGCPORTAL_E2E_PORT** (`ugcportal-wds4`, scope: e2e) — [#308](https://github.com/eiriksf-capgemini/ugcportal/pull/308)
- **Stale count comments in page.test.tsx and resale-rights.test.ts (five codes, three ways) and actions.ts's "three form fields", left when ugcportal-hx2 hit its pass budget** (`ugcportal-0fue`, scope: rights) — [#301](https://github.com/eiriksf-capgemini/ugcportal/pull/301)
- **release-cost-report test file: stale header and SHAPES comments, plus PR #300's title type and body wording, left when ugcportal-s4eb hit its pass budget** (`ugcportal-omyh`, scope: review) — [#300](https://github.com/eiriksf-capgemini/ugcportal/pull/300)
- **check-human-merge-labels: no test pins fail-closed for an absent reviewer and an authorless comment; reviewer param undocumented, author fetched unused** (`ugcportal-9uf5`, scope: process) — [#317](https://github.com/eiriksf-capgemini/ugcportal/pull/317)
- **release-cost-report test: no assertion pins that marker lines are skipped when finding the verdict line (mutant survives 173/173)** (`ugcportal-s4eb`, scope: review) — [#300](https://github.com/eiriksf-capgemini/ugcportal/pull/300)
- **check-human-merge-labels: no test pins reviewedHead to the ugcportal-measured line, a mutant reading any at= survives** (`ugcportal-rix6`, scope: process) — [#317](https://github.com/eiriksf-capgemini/ugcportal/pull/317)
- **Three stale comments left by the August removal (#250)** (`ugcportal-x76d`, scope: auth) — [#293](https://github.com/eiriksf-capgemini/ugcportal/pull/293)

### 🏗️ Build & CI

- **Move the prisma CLI family 7.10.0 -> 7.10.1 within range to clear the deepmerge-ts and mysql2 advisories pinned inside it** (`ugcportal-90i5`, scope: deps) — [#303](https://github.com/eiriksf-capgemini/ugcportal/pull/303)
- **CI gate on npm audit --audit-level=high so the advisory count cannot drift back** (`ugcportal-1j4j`, scope: ci) — [#326](https://github.com/eiriksf-capgemini/ugcportal/pull/326)
- **vitest 3.2.7 -> 4.1.x: close the tinypool RCE gadget and the @vitest/mocker path traversal within Node 20** (`ugcportal-gdi0`, scope: deps) — [#295](https://github.com/eiriksf-capgemini/ugcportal/pull/295)

### 🔧 Chores

- **Audit tokens_qa for resumed reviewer agents the way ugcportal-cii0 audited tokens_impl** (`ugcportal-zu0a`, scope: process) — [#294](https://github.com/eiriksf-capgemini/ugcportal/pull/294)
- **Enforce B2: three implementation passes without a clean round stops the bead and re-plans** (`ugcportal-bc04`, scope: process) — [#296](https://github.com/eiriksf-capgemini/ugcportal/pull/296)
- **Dependency review: vendor shadcn's stylesheet so its advisory chain can go, and record the deliberate major-version deferrals** (`ugcportal-pc7s`, scope: deps) — [#292](https://github.com/eiriksf-capgemini/ugcportal/pull/292)
- **MUSIC layer: refuse 'deliver muted' as a clearance while the deliverable is the raw original** (`ugcportal-hx2`, scope: rights) — [#301](https://github.com/eiriksf-capgemini/ugcportal/pull/301)
- **Security review of the application** (`ugcportal-5x8`, scope: security) — [#298](https://github.com/eiriksf-capgemini/ugcportal/pull/298)
- **Architecture review of the application** (`ugcportal-rma`, scope: architecture) — [#302](https://github.com/eiriksf-capgemini/ugcportal/pull/302)
- **PR #302 body: step 7 says attribution on 2/2 commits where the branch has 3; left when ugcportal-rma hit its pass budget** (`ugcportal-rgw7`, scope: architecture) — [#302](https://github.com/eiriksf-capgemini/ugcportal/pull/302)

### 🚫 Closed without a change

- **Curation UI: triage an owner-uploaded original and set its price and licence** (`ugcportal-74w`, scope: curation, resolution: none)
- **Attestation route and origin.ts comments still describe the pre-#305 lock: 'request read only by readJsonBody' twice, no cross-origin 403 in the refusal list, origin.ts names requireAdmin alone (PR #305 round 3 F1-F3)** (`ugcportal-zn42`, scope: api, resolution: none)
- **Playwright e2e suite is flaky at full parallelism against the shared dev-server SQLite database** (`ugcportal-uwh1`, scope: e2e, resolution: none)

## v0.8.1 - 2026-10-16

### 💰 Cost Summary

**Transcript cost (input-token equivalents)**

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| 🐛 Fixes | 926,776 | 3,785,982 | 4,712,758 | 1/14 |
| 📝 Documentation | 2,257,927 | 9,035,828 | 11,293,755 | 4/11 |
| ♻️ Refactoring | — | — | — | 0/1 |
| 🧪 Tests | — | — | — | 0/1 |
| 🏗️ Build & CI | — | — | — | 0/2 |
| 🔧 Chores | 1,924,701 | 7,989,401 | 9,914,102 | 2/8 |
| **Total** | **5,109,404** | **20,811,211** | **25,920,615** | **7/37** |

**Context-size, not cost** (beads with no accepted `cost_ite_*` figure (absent, 0, malformed, or on a side marked incomplete))

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| 🐛 Fixes | 732,735 | 956,944 | 1,689,679 | 8/14 |
| 📝 Documentation | 1,168,257 | 852,140 | 2,020,397 | 7/11 |
| ♻️ Refactoring | — | 997,779 | 997,779 | 1/1 |
| 🧪 Tests | 227,644 | 228,733 | 456,377 | 1/1 |
| 🏗️ Build & CI | 170,510 | 250,667 | 421,177 | 2/2 |
| 🔧 Chores | 1,345,217 | 1,442,624 | 2,787,841 | 5/8 |
| **Total** | **3,644,363** | **4,728,887** | **8,373,250** | **24/37** |

*Transcript cost is priced from local agent transcripts by `scripts/agent-pass-cost.mjs` in input-token equivalents: proportional to price only for a model priced at the standard ratios (two models whose cache read is cheaper are the exceptions), and a relative measure across models; it omits work done inline in an orchestrator session. The context-size table is each agent's final context window, not what it cost, and is not comparable with the first table or summable with it. A bead's figures can keep growing later from review on a follow-up fix without retroactively updating a past release — treat both as a lower bound, not the release's full or final cost.*

### 🐛 Fixes

- **Dashboard: Needs you lists PRs waiting for a human merge and beads labelled stalled-on-human / human-only** (`ugcportal-a2fl`, scope: dashboard) — https://github.com/eiriksf-capgemini/ugcportal/pull/268
- **fix(tooling): gh-app-token rejects every real installation token (dots in the token)** (`ugcportal-qzfu`, scope: tooling) — https://github.com/eiriksf-capgemini/ugcportal/pull/254
- **pr-review-merge's deferral step must file beads in the bead-template form, not as a finding paste** (`ugcportal-nr72`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/281
- **agent-pass-cost parser silently zero-fills skipped files, bad lines and missing usage (PR #255 round-1 findings merged past review)** (`ugcportal-iir8`, scope: tooling) — https://github.com/eiriksf-capgemini/ugcportal/pull/256
- **bead-dashboard pin check loads an ANSI-C or locale-quoted git spec unpinned (npx $'github:o/r' read as $github:o/r, typed directory)** (`ugcportal-73jt`, scope: dashboard) — https://github.com/eiriksf-capgemini/ugcportal/pull/274
- **bead-dashboard comments still describe the release query as a bd --label-pattern glob after it moved to --label-regex** (`ugcportal-qtua`, scope: dashboard) — https://github.com/eiriksf-capgemini/ugcportal/pull/274
- **bead-dashboard says "No bead carries a release label (v*.*.*)" when bd returned beads whose labels match that glob but not the derived x.y.z regex** (`ugcportal-3ffk`, scope: dashboard) — https://github.com/eiriksf-capgemini/ugcportal/pull/274
- **bead-dashboard pin check loads an unpinned git spec placed after a value-taking npm flag it does not list (npx --omit dev owner/repo)** (`ugcportal-pae2`, scope: dashboard) — https://github.com/eiriksf-capgemini/ugcportal/pull/274
- **Dashboard: deferred beads labelled stalled-on-human / human-only are invisible to Waiting on you** (`ugcportal-uu8p`, scope: dashboard) — https://github.com/eiriksf-capgemini/ugcportal/pull/273
- **bd-guard.test.mjs pins skill-file fixtures by line number, so unrelated skill edits break the guard's tests** (`ugcportal-ucnf`, scope: tooling) — https://github.com/eiriksf-capgemini/ugcportal/pull/276
- **Compose image gate: resolve ${VAR:-default} registry images with their default instead of excluding them** (`ugcportal-jgh2`, scope: release) — https://github.com/eiriksf-capgemini/ugcportal/pull/271
- **scripts/lib/is-main.mjs isMainModule misfires through a symlinked path** (`ugcportal-zrvz`, scope: tooling) — https://github.com/eiriksf-capgemini/ugcportal/pull/258
- **cut-release lists beads closed without shipping anything as shipped work, and re-announces PRs an earlier release already listed** (`ugcportal-xb68`, scope: release-tooling) — https://github.com/eiriksf-capgemini/ugcportal/pull/265
- **bead-dashboard classifyGitSpec npm: alias branch is unreachable for git sources and its test labels a named spec as an alias** (`ugcportal-7779`, scope: dashboard) — https://github.com/eiriksf-capgemini/ugcportal/pull/274

### 📝 Documentation

- **A sold item whose clearance lapses: fulfilment issues download URLs without re-evaluating sellability** (`ugcportal-dabx`, scope: fulfillment) — https://github.com/eiriksf-capgemini/ugcportal/pull/227, https://github.com/eiriksf-capgemini/ugcportal/pull/267
- **pr-review-merge marks a sensitive-path PR as waiting on a human (GitHub label + bead label) instead of leaving it only in a comment** (`ugcportal-ub7y`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/284
- **Choose resume or fresh agent for a fix round by carried context and idle time, not by pass count** (`ugcportal-8r06`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/280
- **Cost and performance analysis: test the seven v0.7.0 claims against the data and propose process changes** (`ugcportal-l6t5`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/255
- **An implementer's self-assessment stays attributed and unverified in review briefs and in reports to Eirik until a reviewer has measured it** (`ugcportal-4bok`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/264
- **Long commands in worker briefs: hybrid rule (explicit foreground timeout; over ~8 minutes backgrounded and polled in-turn; a stall reported, not waited out)** (`ugcportal-9u80`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/272
- **pr-review-merge says main has no branch protection; a ruleset now requires branches be up to date** (`ugcportal-li65`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/282
- **pr-review-merge step 4b still calls the approving reviewer "future" after implementers began authoring as the bot** (`ugcportal-srz2`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/286
- **review-standards quotes a five-bead cost figure built on summed context snapshots corrected by ugcportal-cii0** (`ugcportal-bhvk`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/279
- **pre-review checklist lines 4 and 8 have no SCOPE-LIMITING slot for claims-audit's new category** (`ugcportal-lsvf`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/269
- **roles.ts docstring still claims a transaction read 'can't be read stale', a claim lu7's own review flagged as unmeasured** (`ugcportal-5bkn`, scope: auth) — https://github.com/eiriksf-capgemini/ugcportal/pull/257

### ♻️ Refactoring

- **Extract the bead dashboard to its own repo (eiriksf-capgemini/bead-dashboard), run via npx with per-repo config, README as the persistent note** (`ugcportal-zc8s`, scope: dashboard) — https://github.com/eiriksf-capgemini/ugcportal/pull/274

### 🧪 Tests

- **e2e cannot authenticate: no session seeding, so every signed-in acceptance criterion is unverifiable** (`ugcportal-0wh6`, scope: e2e) — https://github.com/eiriksf-capgemini/ugcportal/pull/260

### 🏗️ Build & CI

- **GitHub App token helper so subagents act as hal9000-agent[bot]** (`ugcportal-3ssw`, scope: tooling) — https://github.com/eiriksf-capgemini/ugcportal/pull/252
- **Make the fresh-machine compose gate a written cut-release step and a scheduled anonymous-pull CI check** (`ugcportal-vtgz`, scope: release) — https://github.com/eiriksf-capgemini/ugcportal/pull/263

### 🔧 Chores

- **tokens_impl and tokens_qa record end-of-run context size, not cost, and resumed agents are recorded under two incompatible conventions** (`ugcportal-cii0`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/261, https://github.com/eiriksf-capgemini/ugcportal/pull/262
- **Request the one-hour prompt cache TTL for the main conversation in .claude/settings.json** (`ugcportal-gn8u`, scope: settings) — https://github.com/eiriksf-capgemini/ugcportal/pull/270
- **Stop bd update --notes and backticks in double-quoted bd strings with a check before the command runs** (`ugcportal-vu49`, scope: tooling) — https://github.com/eiriksf-capgemini/ugcportal/pull/259
- **Record review findings per round by family and severity (findings_rN) so the mechanism behind rounds can be measured** (`ugcportal-2jvh`, scope: review) — https://github.com/eiriksf-capgemini/ugcportal/pull/285
- **Implementers author PRs as hal9000-agent-bot so reviewer and author differ and an exact chain is reachable again** (`ugcportal-62b6`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/277
- **Release cost report prices each process control: runs, cost, wall clock, orchestrator share and catches** (`ugcportal-md4c`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/278
- **review-standards: a false claim in a review-thread comment is corrected in place and never blocks or consumes a round** (`ugcportal-n005`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/287
- **claims-audit penalises the vocabulary that scopes a claim down, pushing authors toward vaguer comments** (`ugcportal-fgcb`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/266

## v0.8.0 - 2026-10-16

### 💰 Cost Summary

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 573,419 | 504,746 | 1,078,165 | 1/1 |
| 🐛 Fixes | 402,987 | 531,702 | 934,689 | 1/1 |
| 📝 Documentation | 570,949 | 500,317 | 1,071,266 | 2/2 |
| 🔧 Chores | — | 134,748 | 134,748 | 1/1 |
| **Total** | **1,547,355** | **1,671,513** | **3,218,868** | **5/5** |

*Cost figures come from bead metadata (`tokens_impl`/`tokens_qa`) as recorded as of this release. `tokens_impl` is a best-effort manual estimate that isn't consistently recorded, and a bead's `tokens_qa` can keep growing later from review on a follow-up fix without retroactively updating a past release — treat these totals as a lower bound, not the release's full or final cost.*

### ✨ Features

- **Uploads by configured users publish on upload, with no per-upload rights questions** (`ugcportal-ho7j`, scope: upload) — https://github.com/eiriksf-capgemini/ugcportal/pull/249

### 🐛 Fixes

- **Configured-ness is read from User.configuredHandle, so a person removed from the array stays configured until an operator edits the database** (`ugcportal-lskg`, scope: upload) — https://github.com/eiriksf-capgemini/ugcportal/pull/251

### 📝 Documentation

- **Post-release sizing review: what actually predicts a bead's cost, and are we estimating the wrong variable** (`ugcportal-2hwe`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/248
- **v0.7.0 post-release review: process errors and rule violations observed during the build** (`ugcportal-fbng`, scope: process) — https://github.com/eiriksf-capgemini/ugcportal/pull/247

### 🔧 Chores

- **Remove August from CONFIGURED_USERS** (`ugcportal-m82q`, scope: auth) — https://github.com/eiriksf-capgemini/ugcportal/pull/250

## v0.7.0 - 2026-10-15

### 💰 Cost Summary

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 12,354,415 | 9,801,361 | 22,155,776 | 16/18 |
| 🐛 Fixes | 9,326,747 | 10,781,735 | 20,108,482 | 23/26 |
| 📝 Documentation | 1,723,567 | 2,679,167 | 4,402,734 | 9/9 |
| ♻️ Refactoring | 314,616 | 1,252,262 | 1,566,878 | 3/5 |
| 🧪 Tests | 501,040 | 1,006,669 | 1,507,709 | 1/2 |
| 🏗️ Build & CI | 877,940 | 1,062,664 | 1,940,604 | 2/2 |
| 🔧 Chores | 2,535,995 | 1,754,014 | 4,290,009 | 5/6 |
| **Total** | **27,634,320** | **28,337,872** | **55,972,192** | **59/68** |

*Cost figures come from bead metadata (`tokens_impl`/`tokens_qa`) as recorded as of this release. `tokens_impl` is a best-effort manual estimate that isn't consistently recorded, and a bead's `tokens_qa` can keep growing later from review on a follow-up fix without retroactively updating a past release — treat these totals as a lower bound, not the release's full or final cost.*

### ✨ Features

- **An item recorded as depicting alcohol is withheld from every public surface (option a, true-only)** (`ugcportal-qnq9.11`, scope: gallery) — [#243](https://github.com/eiriksf-capgemini/ugcportal/pull/243)
- **A live dev dashboard: beads, PRs, agents and what remains in the release, on one page** (`ugcportal-vr9q`, scope: dashboard) — [#235](https://github.com/eiriksf-capgemini/ugcportal/pull/235)
- **Agent definitions carry the rules that are identical in every brief, and nothing else** (`ugcportal-xxw7`, scope: process) — [#231](https://github.com/eiriksf-capgemini/ugcportal/pull/231)
- **A bead fails a mechanical check before work starts on it** (`ugcportal-kt3k`, scope: process) — [#230](https://github.com/eiriksf-capgemini/ugcportal/pull/230)
- **Terracotta is defined and used nowhere: put the accent on the primary CTA and the for-sale badge** (`ugcportal-dmne`, scope: design) — [#220](https://github.com/eiriksf-capgemini/ugcportal/pull/220)
- **Time-scope a clearance to material the reviewer could examine** (`ugcportal-aqw`, scope: rights) — [#217](https://github.com/eiriksf-capgemini/ugcportal/pull/217)
- **Theme phase 2: borders, form fields and cards move off the near-black scale onto paper** (`ugcportal-6uc2`, scope: design) — [#209](https://github.com/eiriksf-capgemini/ugcportal/pull/209)
- **Nothing detects that a bead's gate became unreachable because every blocker was deferred** (`ugcportal-z4nh`, scope: process) — [#207](https://github.com/eiriksf-capgemini/ugcportal/pull/207)
- **Publishing is restricted to operators only by accident: adding a sign-in email would silently grant it** (`ugcportal-9gt1`, scope: rights) — [#206](https://github.com/eiriksf-capgemini/ugcportal/pull/206)
- **Decide what an uploader/admin rights disagreement means for sellability** (`ugcportal-9pic`, scope: rights)
- **Curation pricing: set a price, with sellability re-evaluated at render** (`ugcportal-yzo7`, scope: curation) — [#203](https://github.com/eiriksf-capgemini/ugcportal/pull/203)
- **Publishing an upload requires the uploader attestation and, where people are shown, a PEOPLE clearance** (`ugcportal-3ae`, scope: media) — [#200](https://github.com/eiriksf-capgemini/ugcportal/pull/200)
- **Triage shows the uploader's attestation beside the admin flag, and warns where they disagree** (`ugcportal-vlnn`, scope: curation) — [#202](https://github.com/eiriksf-capgemini/ugcportal/pull/202)
- **Curation clearances: per-layer rights clearances, where clearing one layer settles only that layer** (`ugcportal-qfy9`, scope: rights) — [#199](https://github.com/eiriksf-capgemini/ugcportal/pull/199)
- **Per-upload rights attestation by the uploader, stored and read by the sellability gate** (`ugcportal-15r`, scope: rights) — [#197](https://github.com/eiriksf-capgemini/ugcportal/pull/197)
- **Curation triage: admin screen that records the per-upload triage facts** (`ugcportal-vq3z`, scope: curation) — [#196](https://github.com/eiriksf-capgemini/ugcportal/pull/196)
- **cut-release reconciles the previous release's retrospective recommendations into beads before shipping** (`ugcportal-p7x7`, scope: release-tooling) — [#189](https://github.com/eiriksf-capgemini/ugcportal/pull/189)
- **Dev command that publishes every unpublished upload in the local database through the publish endpoint** (`ugcportal-x8sx`, scope: dev-tools) — [#186](https://github.com/eiriksf-capgemini/ugcportal/pull/186)

### 🐛 Fixes

- **docker compose up cannot pull the pinned MinIO images: quay.io/minio returns 401 and Docker Hub has none** (`ugcportal-s2qp`, scope: docker) — [#244](https://github.com/eiriksf-capgemini/ugcportal/pull/244)
- **The bead validator passes a premise commit that is not on main, and five smaller round-3 findings merged with it** (`ugcportal-7sjc`, scope: process) — [#236](https://github.com/eiriksf-capgemini/ugcportal/pull/236)
- **Header wordmark truncates to one letter on the signed-in 390px view with a long name plus Upload and Sign out** (`ugcportal-ry6w`, scope: design) — [#239](https://github.com/eiriksf-capgemini/ugcportal/pull/239)
- **Item page figure wrapper hardcodes rounded-md (8px) beside a 10px advertising label; radius tokens outside gallery/containment.ts are not shared** (`ugcportal-7ajb`, scope: design) — [#240](https://github.com/eiriksf-capgemini/ugcportal/pull/240)
- **petrol-theme held-back check fails on Next's not-found page: axe region violation at 320px for /admin/settings/rights as a visitor** (`ugcportal-0dh5`, scope: design)
- **p3v's checkout sellability criterion was written, rewritten and verified -- and is not in the bead** (`ugcportal-zbcs`, scope: rights) — [#234](https://github.com/eiriksf-capgemini/ugcportal/pull/234)
- **pr-review-merge's CI gate reads `gh pr checks`, which a title/body edit makes report `skipping` for a check that passed** (`ugcportal-h0ef`, scope: process) — [#232](https://github.com/eiriksf-capgemini/ugcportal/pull/232)
- **The production runner image ships the whole repo: 436 src files, 255 test/spec files, docs and compose files under /app** (`ugcportal-6jcq`, scope: docker) — [#224](https://github.com/eiriksf-capgemini/ugcportal/pull/224)
- **A benefit or link recorded on an already-published item is never asked the § 9-2 alcohol question** (`ugcportal-pgpq`, scope: disclosure) — [#221](https://github.com/eiriksf-capgemini/ugcportal/pull/221)
- **Disclosure withdrawal leaves commercial links attached and publish never re-checks the pair** (`ugcportal-jain`, scope: rights) — [#214](https://github.com/eiriksf-capgemini/ugcportal/pull/214)
- **Hero collage reads as broken images: 160px in a 490px hero, filled with flat blue blocks** (`ugcportal-a3hj`, scope: design) — [#215](https://github.com/eiriksf-capgemini/ugcportal/pull/215)
- **upload-form.tsx's text-ink-muted (alt-text/caption helper copy) is unreadable on the paper canvas (~1.9:1)** (`ugcportal-galb`, scope: design) — [#211](https://github.com/eiriksf-capgemini/ugcportal/pull/211)
- **(BUG) triage-form.tsx's text-ink-muted is unreadable on the paper canvas (1.90:1) - the plain-canvas sweep was done file-by-file and missed it** (`ugcportal-7g2o`, scope: design) — [#211](https://github.com/eiriksf-capgemini/ugcportal/pull/211)
- **A published row whose clearance later lapses stays public: PUBLIC_MEDIA_SCOPE never consults the gate** (`ugcportal-nffp`, scope: rights) — [#208](https://github.com/eiriksf-capgemini/ugcportal/pull/208)
- **vitest collects duplicate/broken test files from .next/standalone after a local build** (`ugcportal-l99p`, scope: testing) — [#205](https://github.com/eiriksf-capgemini/ugcportal/pull/205)
- **classifySeverity's same-line flag exclusion zeroes a real count when an unrelated --word (e.g. a CSS custom property) appears later in the same long prose line** (`ugcportal-x9c7`, scope: process) — [#201](https://github.com/eiriksf-capgemini/ugcportal/pull/201)
- **release-cost-report: severity parser reads a bare number as a medium count (PR #121 shows r1:121 on a zero-finding approval)** (`ugcportal-zo8n`, scope: process) — [#201](https://github.com/eiriksf-capgemini/ugcportal/pull/201)
- **release-cost-report: outcome heuristic labels 66 of 77 v0.6.0 PRs 'human (sensitive path)' because 'no sensitive paths touched' matches** (`ugcportal-577s`, scope: process) — [#201](https://github.com/eiriksf-capgemini/ugcportal/pull/201)
- **When an item is reclassified as depicting alcohol after a commercial link exists, the write must refuse or detach the link** (`ugcportal-6uxv`, scope: disclosure) — [#198](https://github.com/eiriksf-capgemini/ugcportal/pull/198)
- **Header exposes two navigation landmarks, the second containing only Upload** (`ugcportal-i7lr`, scope: a11y) — [#194](https://github.com/eiriksf-capgemini/ugcportal/pull/194)
- **One petrol scale: @theme and :root currently resolve the same name to two different colours** (`ugcportal-uo15`, scope: design-system) — [#193](https://github.com/eiriksf-capgemini/ugcportal/pull/193)
- **npm run build and npm run start do not check migrations, so a production-shaped local run still boots against a stale schema** (`ugcportal-i40s`, scope: db) — [#195](https://github.com/eiriksf-capgemini/ugcportal/pull/195)
- **GET /api/auth/session returns the raw Session row, sessionToken included, to the browser** (`ugcportal-5gii`, scope: auth) — [#192](https://github.com/eiriksf-capgemini/ugcportal/pull/192)
- **[bug] Non-breaking security upgrades: Next 16.4.0 closes seven advisories including the one genuine critical, RCE in next/og** (`ugcportal-fuv2`, scope: deps) — [#191](https://github.com/eiriksf-capgemini/ugcportal/pull/191)
- **Forced-colors disclosure comment (ugcportal-oavb) is duplicated at two call sites instead of once at the base-class root cause** (`ugcportal-n9rc`, scope: design) — [#170](https://github.com/eiriksf-capgemini/ugcportal/pull/170)
- **release-cost-v0.5.0-vs-v0.6.0.md: tokens_impl_passes coverage is 61 of 85, not 59 (missing 24, not 26)** (`ugcportal-2w2m`, scope: process) — [#188](https://github.com/eiriksf-capgemini/ugcportal/pull/188)

### 📝 Documentation

- **Add the size="sm" allowlist guard to pre-review step 2's table** (`ugcportal-szq0`, scope: process) — [#245](https://github.com/eiriksf-capgemini/ugcportal/pull/245)
- **Decide the mechanism that keeps commercial and personal wine content apart, before qnq9.11 is implemented** (`ugcportal-6yrd`, scope: gallery)
- **Re-record LEGAL_SIGN_OFF: /privacy and /licence are both in draft after two merged prose changes** (`ugcportal-xh4j`, scope: legal) — [#223](https://github.com/eiriksf-capgemini/ugcportal/pull/223)
- **Family 1's sweep is scoped to the diff, but a diff can falsify text arbitrarily far from itself** (`ugcportal-78ka`, scope: process) — [#213](https://github.com/eiriksf-capgemini/ugcportal/pull/213)
- **curation-triage-write.ts asserts the adapter-libsql deferred premise its own docstring retracts** (`ugcportal-x8ab`, scope: curation) — [#216](https://github.com/eiriksf-capgemini/ugcportal/pull/216)
- **Write down the ugcportal development process end to end, from prompt to retrospective** (`ugcportal-ag06`, scope: process) — [#210](https://github.com/eiriksf-capgemini/ugcportal/pull/210), [#212](https://github.com/eiriksf-capgemini/ugcportal/pull/212)
- **Privacy page: describe the uploader's rights attestation and re-record the legal sign-off** (`ugcportal-fsdf`, scope: legal) — [#204](https://github.com/eiriksf-capgemini/ugcportal/pull/204)
- **Three-release view v0.4.0 to v0.6.0: one document with every measure side by side and the trend per measure** (`ugcportal-k06e`, scope: process) — [#188](https://github.com/eiriksf-capgemini/ugcportal/pull/188)
- **v0.6.0 process retrospective: rounds per PR, cost per bead, human-merge share, against the v0.5.0 baseline** (`ugcportal-7dtn`, scope: process) — [#187](https://github.com/eiriksf-capgemini/ugcportal/pull/187)

### ♻️ Refactoring

- **header-sm stays a dedicated cva size key: four call sites pinned byte-for-byte, cn() override rejected** (`ugcportal-hhjq`, scope: design) — [#237](https://github.com/eiriksf-capgemini/ugcportal/pull/237)
- **header-sm/sm naming gives no guardrail against a future public-page control picking plain size="sm" and missing K2's shared radius** (`ugcportal-gdn3`, scope: design) — [#242](https://github.com/eiriksf-capgemini/ugcportal/pull/242)
- **empty-state.tsx's adoption of the outline variant silently changes border colour (border-input to border-primary) and adds hover:underline, not mentioned in that call site's own comment** (`ugcportal-pvjn`, scope: design) — [#238](https://github.com/eiriksf-capgemini/ugcportal/pull/238)
- **hero.tsx's buttonVariants call silently drops the old hand-rolled className's w-fit, undisclosed unlike every other changed token at that call site** (`ugcportal-ocbo`, scope: design) — [#215](https://github.com/eiriksf-capgemini/ugcportal/pull/215)
- **Run review finder angles as tool calls inside one reviewer instead of sibling forks** (`ugcportal-ytai`, scope: process) — [#155](https://github.com/eiriksf-capgemini/ugcportal/pull/155)

### 🧪 Tests

- **Tailwind scans bare utility strings inside comments and docs; add one repo-wide guard for unprefixed dangerous-shaped utilities instead of per-file special cases** (`ugcportal-rj7y`, scope: design) — [#241](https://github.com/eiriksf-capgemini/ugcportal/pull/241)
- **Restore the suspended legal positive-path and env-precedence tests once a sign-off lands** (`ugcportal-44qs`, scope: legal) — [#223](https://github.com/eiriksf-capgemini/ugcportal/pull/223)

### 🏗️ Build & CI

- **Run the real production image from docker compose, pinned, for manual QA** (`ugcportal-fb32`, scope: docker) — [#222](https://github.com/eiriksf-capgemini/ugcportal/pull/222)
- **A PR stacked on another PR runs no CI, and the auto-retarget that lands it skips the quality job** (`ugcportal-hwpc`, scope: ci) — [#228](https://github.com/eiriksf-capgemini/ugcportal/pull/228)

### 🔧 Chores

- **The process instruments fail open: a check that matches nothing reports success** (`ugcportal-kssp`, scope: process) — [#229](https://github.com/eiriksf-capgemini/ugcportal/pull/229)
- **No automated guard catches a Tailwind class built via string interpolation — the exact bug a live screenshot caught in ugcportal-a3hj** (`ugcportal-wz8w`, scope: lint) — [#218](https://github.com/eiriksf-capgemini/ugcportal/pull/218)
- **The rights and disclosure system has no review owner: nine models and six routes shipped after both review beads were written** (`ugcportal-l9qx`, scope: security) — [#219](https://github.com/eiriksf-capgemini/ugcportal/pull/219)
- **Counsel questions from the manual-upload rights review (minors, Art. 9, transfers, RMI, AI, § 24, retention, self-clearance)** (`ugcportal-ryd`, scope: legal)
- **Re-verify the premise of every bead in the v0.7.0 line-up against current main before any of it is picked up** (`ugcportal-j5fl`, scope: process) — [#190](https://github.com/eiriksf-capgemini/ugcportal/pull/190)
- **MinIO dev compose: host ports configurable so a Zscaler-occupied 9000 does not block local storage** (`ugcportal-20bb`, scope: storage) — [#185](https://github.com/eiriksf-capgemini/ugcportal/pull/185)

## v0.6.0 - 2026-10-07

### 💰 Cost Summary

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 7,650,607 | 4,134,460 | 11,785,067 | 16/16 |
| 🐛 Fixes | 8,181,006 | 9,978,370 | 18,159,376 | 25/30 |
| 📝 Documentation | 1,304,144 | 1,555,308 | 2,859,452 | 9/9 |
| ♻️ Refactoring | 2,378,838 | 1,941,389 | 4,320,227 | 6/6 |
| 🧪 Tests | 1,964,589 | 2,407,991 | 4,372,580 | 7/7 |
| 🏗️ Build & CI | 770,110 | 809,572 | 1,579,682 | 6/6 |
| 🔧 Chores | 2,181,362 | 2,328,754 | 4,510,116 | 7/11 |
| **Total** | **24,430,656** | **23,155,844** | **47,586,500** | **76/85** |

*Cost figures come from bead metadata (`tokens_impl`/`tokens_qa`) as recorded as of this release. `tokens_impl` is a best-effort manual estimate that isn't consistently recorded, and a bead's `tokens_qa` can keep growing later from review on a follow-up fix without retroactively updating a past release — treat these totals as a lower bound, not the release's full or final cost.*

### ✨ Features

- **Per-link marker, rel hardening and every-surface and feed exposure of commercial links** (`ugcportal-qnq9.2.2`, scope: disclosure) — [#183](https://github.com/eiriksf-capgemini/ugcportal/pull/183)
- **Commercial-link record: destination, network and the brand/alcohol attach gate** (`ugcportal-qnq9.2.1`, scope: disclosure) — [#176](https://github.com/eiriksf-capgemini/ugcportal/pull/176)
- **Wine-accessory commerce: alcohol must never appear in commercial imagery, and alcohol-linked brands are refused** (`ugcportal-qnq9.3`, scope: rights) — [#157](https://github.com/eiriksf-capgemini/ugcportal/pull/157), [#168](https://github.com/eiriksf-capgemini/ugcportal/pull/168)
- **Affiliate and commercial outbound links: labelled per link, labelled at the top, consent-gated, never on alcohol** (`ugcportal-qnq9.2`, scope: disclosure) — [#176](https://github.com/eiriksf-capgemini/ugcportal/pull/176), [#183](https://github.com/eiriksf-capgemini/ugcportal/pull/183)
- **Advertising disclosure A: record the benefit behind an item and gate publishing on a permitted label** (`ugcportal-qnq9.1`, scope: disclosure) — [#147](https://github.com/eiriksf-capgemini/ugcportal/pull/147)
- **Share buttons + Open Graph preview tags** (`ugcportal-lju`, scope: sharing) — [#180](https://github.com/eiriksf-capgemini/ugcportal/pull/180)
- **Advertising disclosure B: render the advertising label on the public item page and feed, and expose it through MEDIA_ANONYMOUS_SELECT** (`ugcportal-e0jv`, scope: disclosure) — [#162](https://github.com/eiriksf-capgemini/ugcportal/pull/162)
- **claims-audit cannot see the PR body, where most late-round family-1 findings now live** (`ugcportal-bn94`, scope: process) — [#154](https://github.com/eiriksf-capgemini/ugcportal/pull/154)
- **Empty state shows portfolio tiles, not a sentence and a clipped button** (`ugcportal-qqnt.5`, scope: design) — [#177](https://github.com/eiriksf-capgemini/ugcportal/pull/177)
- **Hero: a 25-word lead, one visitor call to action ('See the portfolio'), and three overlapping photographs instead of decorative circles** (`ugcportal-qqnt.4`, scope: design) — [#173](https://github.com/eiriksf-capgemini/ugcportal/pull/173)
- **Header: one row with a brand mark and a wordmark that outranks the nav, no tagline row, and a single sign-in control** (`ugcportal-qqnt.3`, scope: design) — [#171](https://github.com/eiriksf-capgemini/ugcportal/pull/171)
- **Front page type scale: the hero carries the h1, section titles step down, and Fraunces is reserved for display** (`ugcportal-qqnt.1`, scope: design) — [#114](https://github.com/eiriksf-capgemini/ugcportal/pull/114)
- **Front page UX polish: hierarchy, one button system, a real hero visual and an above-the-fold portfolio** (`ugcportal-qqnt`, scope: design) — [#181](https://github.com/eiriksf-capgemini/ugcportal/pull/181)
- **Discoverability: per-item pages with descriptive titles, a sitemap, and Search Console and Pinterest site verification** (`ugcportal-qnq9.12`, scope: seo) — [#144](https://github.com/eiriksf-capgemini/ugcportal/pull/144)
- **Minors as a first-class per-upload triage fact, on a reusable null-blocks mechanism** (`ugcportal-qn3`, scope: rights) — [#145](https://github.com/eiriksf-capgemini/ugcportal/pull/145)
- **No product surface records a brand as alcohol-linked after it was first answered no; the disclosure route can only write null to false** (`ugcportal-mqh8`, scope: rights) — [#174](https://github.com/eiriksf-capgemini/ugcportal/pull/174)

### 🐛 Fixes

- **pre-push hook exports GIT_DIR and GIT_WORK_TREE into the test run, so any test that shells out to git operates on the real repository** (`ugcportal-xxy2`, scope: tooling) — [#135](https://github.com/eiriksf-capgemini/ugcportal/pull/135)
- **npm run dev starts against a dev.db that is six migrations behind, so every auth() call and every sign-in fails with 'no such column'** (`ugcportal-w7wc`, scope: db) — [#117](https://github.com/eiriksf-capgemini/ugcportal/pull/117)
- **GALLERY_ADVERTISING_LABEL_CLASS still uses rounded-md (8px) after qqnt.2 moved the tile it sits beside to rounded-lg (10px); its own comment now falsely claims they match** (`ugcportal-o312`, scope: design) — [#169](https://github.com/eiriksf-capgemini/ugcportal/pull/169)
- **readJsonBody has no idle timeout: a stalled JSON request holds a slot for 300s on three routes** (`ugcportal-8hsf`, scope: upload) — [#158](https://github.com/eiriksf-capgemini/ugcportal/pull/158)
- **code-review finder forks posted directly to the live PR, including a stray write-access test comment, despite read-only instructions** (`ugcportal-cr2h`, scope: process) — [#155](https://github.com/eiriksf-capgemini/ugcportal/pull/155)
- **Finder-angle forks spawned by a reviewer report to the orchestrator, leaving the reviewer waiting indefinitely** (`ugcportal-p4jw`, scope: process) — [#155](https://github.com/eiriksf-capgemini/ugcportal/pull/155)
- **Branch cleanup must retarget open PRs based on a branch before deleting it** (`ugcportal-hvaf`, scope: process) — [#143](https://github.com/eiriksf-capgemini/ugcportal/pull/143), [#152](https://github.com/eiriksf-capgemini/ugcportal/pull/152)
- **code-review fork force-removed another agent's review worktree it did not create** (`ugcportal-lasi`, scope: process) — [#155](https://github.com/eiriksf-capgemini/ugcportal/pull/155)
- **claims-audit reports 0 candidates on uncommitted files and ignores --base=<ref>, producing a false all-clean before the first commit** (`ugcportal-np1i`, scope: process) — [#133](https://github.com/eiriksf-capgemini/ugcportal/pull/133)
- **Build warns: node:crypto from legal/publishable.ts reaches the Edge Instrumentation bundle** (`ugcportal-177y`, scope: privacy) — [#111](https://github.com/eiriksf-capgemini/ugcportal/pull/111)
- **Gallery does not branch on kind: a published video renders as a photograph** (`ugcportal-dzz`, scope: gallery) — [#146](https://github.com/eiriksf-capgemini/ugcportal/pull/146)
- **Upload peek has no idle timeout: a stalled multipart connection holds a request slot for 300s** (`ugcportal-dvb`, scope: upload) — [#149](https://github.com/eiriksf-capgemini/ugcportal/pull/149)
- **request-body.test.ts: the EXPECTED docstring still describes true/false entries after the list became verdict-suffixed strings** (`ugcportal-ufdx`, scope: upload) — [#158](https://github.com/eiriksf-capgemini/ugcportal/pull/158)
- **K4 guard: a dangling function pointer and an assertion that cannot fail in the escape-rule fixtures** (`ugcportal-bq1k`, scope: storage) — [#156](https://github.com/eiriksf-capgemini/ugcportal/pull/156)
- **sweep-merged-branches deletes remote branches with git push --delete, which runs the full pre-push suite and fails on load flakes; use the GitHub API ref delete instead** (`ugcportal-ix0s`, scope: process) — [#165](https://github.com/eiriksf-capgemini/ugcportal/pull/165)
- **buttonVariants base uses outline-none plus a ring for focus-visible, invisible under forced-colors; every public-page button inherits it** (`ugcportal-oavb`, scope: design) — [#170](https://github.com/eiriksf-capgemini/ugcportal/pull/170)
- **claims-audit.test.mjs K2 flakes on the 5s default timeout under machine load** (`ugcportal-5whs`, scope: process) — [#163](https://github.com/eiriksf-capgemini/ugcportal/pull/163)
- **check-migrations.mjs loads only .env while Next also loads .env.local with precedence, so a DATABASE_URL in .env.local alone migrates one database and serves another** (`ugcportal-h2yd`, scope: db) — [#160](https://github.com/eiriksf-capgemini/ugcportal/pull/160)
- **Button default-neutral's label colour compiles to no utility, so the measured contrast pairing is for a colour never painted** (`ugcportal-ei5c`, scope: design) — [#175](https://github.com/eiriksf-capgemini/ugcportal/pull/175)
- **About page contact notice links /privacy while the statement is still a draft in production** (`ugcportal-nf9l`, scope: legal) — [#140](https://github.com/eiriksf-capgemini/ugcportal/pull/140)
- **Upload queue 'Try again' button unmounts under keyboard focus, dropping focus to body** (`ugcportal-ff2a`, scope: upload) — [#112](https://github.com/eiriksf-capgemini/ugcportal/pull/112)
- **S3-touching sibling routes answer transport failures as an undifferentiated 500/redirect, not a deliberate 503** (`ugcportal-98rb`, scope: storage) — [#156](https://github.com/eiriksf-capgemini/ugcportal/pull/156)
- **K2's contrast gate has no coverage check for non-alpha-modified colour utilities** (`ugcportal-5gca`, scope: process) — [#115](https://github.com/eiriksf-capgemini/ugcportal/pull/115)
- **The evidence-encryption startup check and encryptionSetting() disagree about any value needing a trim** (`ugcportal-gkj`, scope: rights) — [#153](https://github.com/eiriksf-capgemini/ugcportal/pull/153)
- **Upload form "Choose files" label hand-pastes bg-petrol-400 text-petrol-900, a label colour that compiles to no utility** (`ugcportal-z1nh`, scope: design) — [#182](https://github.com/eiriksf-capgemini/ugcportal/pull/182)
- **claims-audit: a listTrackedFiles() failure does not set workingTreeReadFailed, so every reference to an existing file is falsely flagged REFERENCE not found** (`ugcportal-aigs`, scope: process) — [#161](https://github.com/eiriksf-capgemini/ugcportal/pull/161)
- **Lightbox fade animation ignores prefers-reduced-motion** (`ugcportal-i72n`, scope: gallery) — [#124](https://github.com/eiriksf-capgemini/ugcportal/pull/124)
- **Post-cap lows from PR #85: monotonic clock for the throttle, two-way SDK parity test, stale call-site comment, shared body-record guard, attempts field per branch, shared log interval, looser cleanup-log assertion** (`ugcportal-qz1u`, scope: upload) — [#130](https://github.com/eiriksf-capgemini/ugcportal/pull/130)
- **GET /api/public/media's 500 on a thrown listing error has no cache-control: no-store** (`ugcportal-c70s`, scope: process) — [#108](https://github.com/eiriksf-capgemini/ugcportal/pull/108)
- **NODE_OPTIONS=--inspect attaches to the with-local-ca wrapper instead of the wrapped Next.js process** (`ugcportal-ymp4`, scope: tooling) — [#139](https://github.com/eiriksf-capgemini/ugcportal/pull/139)

### 📝 Documentation

- **Release cost comparison v0.4.0 vs v0.5.0: cost per feature, model performance, the most expensive features and how to reduce them** (`ugcportal-apsq`, scope: process) — [#104](https://github.com/eiriksf-capgemini/ugcportal/pull/104)
- **/privacy uploads category must name the advertising-disclosure record (BenefitSource, MediaAdvertisingDisclosure) and both LEGAL_SIGN_OFF digests must be re-recorded** (`ugcportal-mj50`, scope: privacy) — [#167](https://github.com/eiriksf-capgemini/ugcportal/pull/167)
- **pr-review-merge stamps the round marker inside the approval body, but approving your own PR is impossible on this repo, so merged rounds can end with no marker** (`ugcportal-u25s`, scope: process) — [#142](https://github.com/eiriksf-capgemini/ugcportal/pull/142)
- **Backlog review before v0.6.0: audit of every open bead, release line-up and mardi-gras status model** (`ugcportal-t7oh`, scope: process) — [#106](https://github.com/eiriksf-capgemini/ugcportal/pull/106)
- **CLAUDE.md token-cost paragraph still says pr-review-merge forks code-review and records an exact subagent_tokens figure; stale once PR #155 merges** (`ugcportal-a4ue`, scope: process) — [#159](https://github.com/eiriksf-capgemini/ugcportal/pull/159)
- **pr-review-merge SKILL.md: two stale sentences, step 2 overclaims guard-sensitive-files hard-fails every CLAUDE.md diff, and the "Two residual limits" paragraph still calls the review body the approval marker home** (`ugcportal-yvbi`, scope: process) — [#151](https://github.com/eiriksf-capgemini/ugcportal/pull/151)
- **auth.ts comment still says the upload page calls plain auth() and costs two session queries** (`ugcportal-0cdw`, scope: auth) — [#118](https://github.com/eiriksf-capgemini/ugcportal/pull/118)
- **Front page: one e2e comment attributes the shapes' opacity 0 to the wrong class** (`ugcportal-quxl`, scope: design) — [#148](https://github.com/eiriksf-capgemini/ugcportal/pull/148)
- **Scanner PR follow-up: two stale counts in comments (fail-closed exits, confirmed holes)** (`ugcportal-96eb`, scope: privacy) — [#119](https://github.com/eiriksf-capgemini/ugcportal/pull/119)

### ♻️ Refactoring

- **One button system on the public pages: a primary, a secondary, one radius, used identically in header, hero and empty state** (`ugcportal-qqnt.2`, scope: design) — [#122](https://github.com/eiriksf-capgemini/ugcportal/pull/122)
- **Post-cap lows from PR #93: preview re-check, strip-at-query, stale mock, duplicated classes, stacked JSDoc, thin wrapper** (`ugcportal-qnq9.16`, scope: portfolio) — [#166](https://github.com/eiriksf-capgemini/ugcportal/pull/166)
- **Post-cap lows from PR #90: per-page boot message, operator-value sanity scan, test-support comment, shared legal loader** (`ugcportal-qnq9.15`, scope: privacy) — [#164](https://github.com/eiriksf-capgemini/ugcportal/pull/164)
- **Post-cap lows from PR #87: shared click helper, fake-timer block, useLayoutEffect handoff, event.currentTarget instead of a ref, getter accessors, targeted selector** (`ugcportal-dj4i`, scope: gallery) — [#134](https://github.com/eiriksf-capgemini/ugcportal/pull/134)
- **Post-cap lows from PR #81: shared entry-match predicate, strict colon spacing, floating JSDoc, double parse per sign-in** (`ugcportal-qlfo`, scope: auth) — [#150](https://github.com/eiriksf-capgemini/ugcportal/pull/150)
- **Extract one first-occurrence-wins dedupe helper for gallery-items, tags and sign-in-policy** (`ugcportal-oejb`, scope: lib) — [#128](https://github.com/eiriksf-capgemini/ugcportal/pull/128)

### 🧪 Tests

- **Tree-walking test suites (claims-audit, analytics-host.grep, throttled-log.no-sibling-copy, sweep-merged-branches, watermark) time out at the 5 s default under machine load, making the pre-push hook a coin flip** (`ugcportal-9faa`, scope: process) — [#163](https://github.com/eiriksf-capgemini/ugcportal/pull/163)
- **rights page test 'does not appear at exactly the page size' times out at 5s under CI load, failing unrelated PRs** (`ugcportal-qudv`, scope: admin) — [#132](https://github.com/eiriksf-capgemini/ugcportal/pull/132)
- **No CI-wired test renders AuthStatus and asserts it actually uses size="header-sm" (only e2e, not wired into CI, checks the real radius)** (`ugcportal-6wkd`, scope: design) — [#178](https://github.com/eiriksf-capgemini/ugcportal/pull/178)
- **Reduced-motion scan: residual variant shapes and the e2e directory Tailwind's @source not would not exclude** (`ugcportal-61pv`, scope: design) — [#129](https://github.com/eiriksf-capgemini/ugcportal/pull/129)
- **Footer K2 string test is inclusion-only; header e2e locators unscoped to the banner landmark** (`ugcportal-6uxr`, scope: design) — [#179](https://github.com/eiriksf-capgemini/ugcportal/pull/179)
- **Header: assert the mobile toggle's position in the header-order test; cover the remaining modifier-click guards** (`ugcportal-0sdf`, scope: design) — [#179](https://github.com/eiriksf-capgemini/ugcportal/pull/179)
- **Post-cap lows from PR #91: pinEnvironment comment overclaims; session id is case-folded before the delete** (`ugcportal-0p5s`, scope: auth) — [#138](https://github.com/eiriksf-capgemini/ugcportal/pull/138)

### 🏗️ Build & CI

- **CI: a PR body edit cancels the in-flight push run and then skips the quality job, leaving the head with no test result** (`ugcportal-sxwb`, scope: process) — [#137](https://github.com/eiriksf-capgemini/ugcportal/pull/137)
- **CI bills five rounded-up jobs per run and re-runs the full suite on every PR body edit, exhausting the Actions minutes** (`ugcportal-0an4`, scope: process) — [#127](https://github.com/eiriksf-capgemini/ugcportal/pull/127)
- **Pre-push hook skips the full suite when an agent push sets UGCPORTAL_PREPUSH=skip; CI stays authoritative** (`ugcportal-cky9`, scope: process) — [#172](https://github.com/eiriksf-capgemini/ugcportal/pull/172)
- **Wire 'prisma migrate diff --exit-code' into CI as a drift guard** (`ugcportal-33hi`, scope: process) — [#110](https://github.com/eiriksf-capgemini/ugcportal/pull/110)
- **guard-sensitive-files fails a CLAUDE.md-only PR too, so the dedicated PR the policy asks for can never be green** (`ugcportal-6hmh`, scope: process) — [#141](https://github.com/eiriksf-capgemini/ugcportal/pull/141)
- **CI title guard rejects hierarchical bead ids (ugcportal-qnq9.14), so every child of an epic cannot be named in a PR title** (`ugcportal-euqi`, scope: process) — [#107](https://github.com/eiriksf-capgemini/ugcportal/pull/107)

### 🔧 Chores

- **PR close must delete the merged origin branch and prune the local worktree** (`ugcportal-nvg0`, scope: process) — [#109](https://github.com/eiriksf-capgemini/ugcportal/pull/109), [#113](https://github.com/eiriksf-capgemini/ugcportal/pull/113)
- **Review process: why most PRs take six rounds, and how to find issues locally before the PR** (`ugcportal-wzgw`, scope: process) — [#105](https://github.com/eiriksf-capgemini/ugcportal/pull/105)
- **Beads sync is local-only: no Dolt remote on the code repository, backup outside the repo folder** (`ugcportal-z3j1`, scope: process) — [#136](https://github.com/eiriksf-capgemini/ugcportal/pull/136)
- **Re-measure subagent Opus share a week after ugcportal-9ak lands** (`ugcportal-0xw`, scope: process) — [#131](https://github.com/eiriksf-capgemini/ugcportal/pull/131)
- **PR #158 body: the rewritten claims-audit paragraph says the fix keeps await reader.cancel() on the 413 path, which is the opposite of what it ships** (`ugcportal-1b88`, scope: process) — [#158](https://github.com/eiriksf-capgemini/ugcportal/pull/158)
- **PR #158 body: the claims-audit --pr figures and the "both contradictions are on one line" note do not reproduce against the posted body** (`ugcportal-g6n6`, scope: process) — [#158](https://github.com/eiriksf-capgemini/ugcportal/pull/158)
- **Consolidate gallery.tsx's inline genuinely-empty check onto gallery-items.ts's isGenuinelyEmptyPage** (`ugcportal-3wcd`, scope: process) — [#121](https://github.com/eiriksf-capgemini/ugcportal/pull/121)
- **Add boot-time S3 reachability warning in src/instrumentation.ts** (`ugcportal-ze1o`, scope: storage) — [#116](https://github.com/eiriksf-capgemini/ugcportal/pull/116)
- **PR #157 body item 6: the "three dots" gloss credits a mechanism that is inert there** (`ugcportal-9v2u`, scope: process) — [#157](https://github.com/eiriksf-capgemini/ugcportal/pull/157)
- **route.test.ts's console.error spy is a blanket global silence rather than scoped** (`ugcportal-f6w3`, scope: process) — [#108](https://github.com/eiriksf-capgemini/ugcportal/pull/108)
- **Duplicated throttled-log pattern between public-media.ts and watermark.ts** (`ugcportal-z3lo`, scope: process) — [#125](https://github.com/eiriksf-capgemini/ugcportal/pull/125)

## v0.5.0 - 2026-10-05

### 💰 Cost Summary

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 5,162,194 | 9,937,510 | 15,099,704 | 10/10 |
| 🐛 Fixes | 4,445,975 | 7,231,522 | 11,677,497 | 14/18 |
| ⚡ Performance | 407,136 | 521,004 | 928,140 | 1/1 |
| 📝 Documentation | 149,000 | 606,688 | 755,688 | 4/8 |
| ♻️ Refactoring | 25,000 | — | 25,000 | 1/1 |
| 🧪 Tests | 328,833 | 404,172 | 733,005 | 3/3 |
| 🏗️ Build & CI | — | 66,769 | 66,769 | 1/1 |
| 🔧 Chores | 599,557 | 628,165 | 1,227,722 | 6/12 |
| **Total** | **11,117,695** | **19,395,830** | **30,513,525** | **40/54** |

*Cost figures come from bead metadata (`tokens_impl`/`tokens_qa`) as recorded as of this release. `tokens_impl` is a best-effort manual estimate that isn't consistently recorded, and a bead's `tokens_qa` can keep growing later from review on a follow-up fix without retroactively updating a past release — treat these totals as a lower bound, not the release's full or final cost.*

### ✨ Features

- **Header: wordmark, tagline and navigation (English)** (`ugcportal-14k9`, scope: design) — [#94](https://github.com/eiriksf-capgemini/ugcportal/pull/94)
- **Bind each permitted sign-in address to a provider (google:/facebook: prefix in ALLOWED_SIGNIN_EMAILS)** (`ugcportal-1551`, scope: auth) — [#81](https://github.com/eiriksf-capgemini/ugcportal/pull/81)
- **Cookie consent: nothing optional loads before active opt-in, behind the least intrusive unambiguous banner** (`ugcportal-3wgp`, scope: privacy) — [#92](https://github.com/eiriksf-capgemini/ugcportal/pull/92)
- **Front page: hero, a clear 'what is this' and a living empty state (English)** (`ugcportal-6dvg`, scope: design) — [#97](https://github.com/eiriksf-capgemini/ugcportal/pull/97)
- **Footer: about, licence, privacy, contact and llms.txt links (English)** (`ugcportal-akv6`, scope: design) — [#96](https://github.com/eiriksf-capgemini/ugcportal/pull/96)
- **Alt text and captions on media, for accessibility and discoverability** (`ugcportal-gwr`, scope: a11y) — [#78](https://github.com/eiriksf-capgemini/ugcportal/pull/78)
- **Add /llms.txt file describing site content (llmstxt.org spec)** (`ugcportal-o7l`, scope: seo) — [#83](https://github.com/eiriksf-capgemini/ugcportal/pull/83)
- **Public about and portfolio pages: the six sample pieces, spec work marked as spec, and a lawful contact route** (`ugcportal-qnq9.7`, scope: pages) — [#93](https://github.com/eiriksf-capgemini/ugcportal/pull/93)
- **Fra svart standardtema til petrol-paletten (tokens, lys/mørk)** (`ugcportal-rw9j`, scope: design) — [#79](https://github.com/eiriksf-capgemini/ugcportal/pull/79)
- **One person, several sign-in identities: a configured users array maps each provider-bound identity to a named user, and sign-in links to that user** (`ugcportal-t33p`, scope: auth) — [#98](https://github.com/eiriksf-capgemini/ugcportal/pull/98)

### 🐛 Fixes

- **A failed gallery fetch tells the visitor the gallery is genuinely empty** (`ugcportal-0dh`, scope: gallery) — [#75](https://github.com/eiriksf-capgemini/ugcportal/pull/75)
- **POST /api/media answers a bare 500 with an unhandled S3 ECONNRESET when object storage is unreachable** (`ugcportal-1b2c`, scope: upload) — [#85](https://github.com/eiriksf-capgemini/ugcportal/pull/85)
- **pr-review-merge round counter: a forged marker still relaxes the gate, and one can DoS it** (`ugcportal-1xf`, scope: process) — [#59](https://github.com/eiriksf-capgemini/ugcportal/pull/59)
- **Lightbox caption order: 9 contradicts its own comment** (`ugcportal-4at`, scope: gallery) — [#65](https://github.com/eiriksf-capgemini/ugcportal/pull/65)
- **Six unaddressed review findings from PR #50, including a --project regression** (`ugcportal-4il`, scope: process) — [#51](https://github.com/eiriksf-capgemini/ugcportal/pull/51), [#53](https://github.com/eiriksf-capgemini/ugcportal/pull/53), [#57](https://github.com/eiriksf-capgemini/ugcportal/pull/57)
- **Button press translate animates under prefers-reduced-motion** (`ugcportal-52ue`, scope: design) — [#101](https://github.com/eiriksf-capgemini/ugcportal/pull/101)
- **with-local-ca.mjs passes through an invalid explicit NODE_EXTRA_CA_CERTS unchanged instead of clearing it** (`ugcportal-5g9t`, scope: auth) — [#76](https://github.com/eiriksf-capgemini/ugcportal/pull/76)
- **Concurrent pr-review-merge runs on one PR permanently break the round chain** (`ugcportal-5xj`, scope: process) — [#59](https://github.com/eiriksf-capgemini/ugcportal/pull/59)
- **A session-store failure takes down every page: the shell's UploadNavLink and AuthStatus await getSession() unguarded** (`ugcportal-8df3`, scope: design) — [#102](https://github.com/eiriksf-capgemini/ugcportal/pull/102)
- **NODE_EXTRA_CA_CERTS in .env.local never reaches Node, so Google and Facebook sign-in both fail behind the TLS-intercepting proxy** (`ugcportal-drt1`, scope: auth) — [#61](https://github.com/eiriksf-capgemini/ugcportal/pull/61)
- **Retry countdown can render from a mount-time clock** (`ugcportal-ggw`, scope: upload) — [#71](https://github.com/eiriksf-capgemini/ugcportal/pull/71)
- **Gallery tiles still scale on hover under prefers-reduced-motion: the guard says transform-none against a scale utility** (`ugcportal-ig4g`, scope: gallery) — [#101](https://github.com/eiriksf-capgemini/ugcportal/pull/101)
- **Dropping a file outside the drop zone navigates away from the upload page** (`ugcportal-juo`, scope: upload) — [#74](https://github.com/eiriksf-capgemini/ugcportal/pull/74)
- **Load more drops keyboard focus, twice** (`ugcportal-jx4`, scope: gallery) — [#87](https://github.com/eiriksf-capgemini/ugcportal/pull/87)
- **The two review skills disagree about what the gate does in six places** (`ugcportal-kvb`, scope: process) — [#59](https://github.com/eiriksf-capgemini/ugcportal/pull/59)
- **Revoking permission to sign in must take effect before the 30-day session expires** (`ugcportal-mzr`, scope: auth) — [#91](https://github.com/eiriksf-capgemini/ugcportal/pull/91)
- **Pinned-uploader banner gives a false reason when the uploader is excluded, not truncated** (`ugcportal-r3h`, scope: rights) — [#67](https://github.com/eiriksf-capgemini/ugcportal/pull/67), [#72](https://github.com/eiriksf-capgemini/ugcportal/pull/72)
- **Replace the hand-rolled comment scanner behind the K6/K2 guards with TypeScript's scanner; close the import-alias lint bypass (post-cap from PR #92)** (`ugcportal-ysub`, scope: privacy) — [#95](https://github.com/eiriksf-capgemini/ugcportal/pull/95)

### ⚡ Performance

- **Partial index for the public media feed: page cost scales with total rows, not published rows** (`ugcportal-ei7`, scope: media) — [#86](https://github.com/eiriksf-capgemini/ugcportal/pull/86)

### 📝 Documentation

- **Write handoff for the process-improvement cleanup and petrol design-round start** (`ugcportal-205x`, scope: process)
- **Audit local and global skills for staleness against the process-improvement phase's changes** (`ugcportal-5znw`, scope: process) — [#62](https://github.com/eiriksf-capgemini/ugcportal/pull/62), [#63](https://github.com/eiriksf-capgemini/ugcportal/pull/63)
- **CLAUDE.md's team-maintainer bullet still describes the pre-severity-gate merge condition** (`ugcportal-7yr7`, scope: process)
- **Write a brief cost/performance-improvement summary for second-brain once the process-improvement phase wraps** (`ugcportal-7z48`, scope: process)
- **scripts/sweep-candidates.mjs docstring says "three-family sweep", now stale after Family 4 (sibling-omission)** (`ugcportal-aj2k`, scope: process) — [#64](https://github.com/eiriksf-capgemini/ugcportal/pull/64)
- **env.example/with-local-ca.mjs claim that NODE_EXTRA_CA_CERTS in .env.local 'never reaches Node' is only true for next start, not next dev** (`ugcportal-cbtk`, scope: tooling)
- **Decision: three wording points in docs/ugc-research.md raised by review (label text, ENK, fine-regulation date)** (`ugcportal-qnq9.14`, scope: research) — [#89](https://github.com/eiriksf-capgemini/ugcportal/pull/89)
- **Publish /personvern and /lisens: the privacy statement and licence text the footer links to, matching what the code actually does** (`ugcportal-qnq9.4`, scope: privacy) — [#90](https://github.com/eiriksf-capgemini/ugcportal/pull/90)

### ♻️ Refactoring

- **Dedupe /upload's own session query with the header's cached getSession()** (`ugcportal-asg`, scope: auth) — [#73](https://github.com/eiriksf-capgemini/ugcportal/pull/73)

### 🧪 Tests

- **request-body test 'does not fire on a body that is merely slow' fails under full-suite load** (`ugcportal-000`, scope: media) — [#77](https://github.com/eiriksf-capgemini/ugcportal/pull/77)
- **public-media.logging.test.ts: two 'query itself throws' tests fail locally while CI on main is green** (`ugcportal-cl4e`, scope: gallery) — [#80](https://github.com/eiriksf-capgemini/ugcportal/pull/80)
- **Identities: the P2002 race-recovery path in createUser has no test; lockup message lows** (`ugcportal-qqgi`, scope: auth) — [#100](https://github.com/eiriksf-capgemini/ugcportal/pull/100)

### 🏗️ Build & CI

- **Add a Python test step to CI so usage_indicators.py self-test is actually enforced** (`ugcportal-d4z`, scope: process) — [#56](https://github.com/eiriksf-capgemini/ugcportal/pull/56)

### 🔧 Chores

- **Spike: evaluate a pre-push gate for the mechanical portion of review, ahead of CI** (`ugcportal-2pnq`, scope: process)
- **Apply CLAUDE_CODE_SUBAGENT_MODEL=sonnet in .claude/settings.json (needs Eirik)** (`ugcportal-2tc`, scope: process)
- **Add pre-push mechanical-check gate to .beads/hooks/pre-push (lint/typecheck/test/build + conditional Python self-test)** (`ugcportal-5dr6`, scope: process) — [#60](https://github.com/eiriksf-capgemini/ugcportal/pull/60)
- **Evaluate where tokens are spent, reduce it, and encode the result as skills** (`ugcportal-bf7`, scope: process) — [#58](https://github.com/eiriksf-capgemini/ugcportal/pull/58)
- **Document S3_EVIDENCE_SSE in env.example and adopt the shared readJsonBody helper** (`ugcportal-e15`, scope: build) — [#82](https://github.com/eiriksf-capgemini/ugcportal/pull/82)
- **.beads.gate.lock is untracked and not gitignored, so every bd call dirties the working tree** (`ugcportal-e5zf`, scope: repo) — [#54](https://github.com/eiriksf-capgemini/ugcportal/pull/54)
- **sweep-candidates.mjs and the pre-push self-test conditional assume checked-out HEAD is what's being pushed** (`ugcportal-lykb`, scope: process) — [#68](https://github.com/eiriksf-capgemini/ugcportal/pull/68)
- **Pre-push candidate-enumeration script for sweep families: toContain needles and sibling-guard omissions** (`ugcportal-plp6`, scope: process) — [#60](https://github.com/eiriksf-capgemini/ugcportal/pull/60)
- **Decision: whose name holds the Stripe account, the affiliate accounts and any contracts** (`ugcportal-qnq9.10`, scope: compliance)
- **Decision: wine and alcohol content on the site, or only on personal channels** (`ugcportal-qnq9.8`, scope: compliance)
- **Decision: hobby or naeringsvirksomhet, and whether an ENK is registered** (`ugcportal-qnq9.9`, scope: compliance)
- **Why do some beads take ten rounds? Reduce retries by detecting failures earlier** (`ugcportal-ws3`, scope: process) — [#60](https://github.com/eiriksf-capgemini/ugcportal/pull/60)

## v0.4.0 - 2026-09-28

### 💰 Cost Summary

| Type | Impl | QA | Total | Beads with data |
|---|---:|---:|---:|:---:|
| ✨ Features | 9,385,668 | 2,031,861 | 11,417,529 | 12/13 |
| 🐛 Fixes | 3,096,177 | 1,755,679 | 4,851,856 | 4/5 |
| ⚡ Performance | 595,443 | 310,432 | 905,875 | 1/1 |
| 📝 Documentation | 360,000 | 193,870 | 553,870 | 2/3 |
| ♻️ Refactoring | 561,941 | 449,599 | 1,011,540 | 1/1 |
| 🧪 Tests | 25,000 | 70,644 | 95,644 | 1/1 |
| 🏗️ Build & CI | 221,988 | — | 221,988 | 3/7 |
| 🔧 Chores | 2,381,048 | 164,046 | 2,545,094 | 3/7 |
| **Total** | **16,627,265** | **4,976,131** | **21,603,396** | **27/38** |

*Cost figures come from bead metadata (`tokens_impl`/`tokens_qa`) as recorded as of this release. `tokens_impl` is a best-effort manual estimate that isn't consistently recorded, and a bead's `tokens_qa` can keep growing later from review on a follow-up fix without retroactively updating a past release — treat these totals as a lower bound, not the release's full or final cost.*

### ✨ Features

- **Per-account resale-rights status (ResaleRightsReview) and the sellability gate for curation/checkout** (`ugcportal-0ss`, scope: instagram) — [#33](https://github.com/eiriksf-capgemini/ugcportal/pull/33)
- **cut-release: add per-type cost summary from tokens_impl/tokens_qa** (`ugcportal-1yr`, scope: release-tooling) — [#19](https://github.com/eiriksf-capgemini/ugcportal/pull/19)
- **Watermark preview service (sharp or imgproxy)** (`ugcportal-44q`, scope: media) — [#29](https://github.com/eiriksf-capgemini/ugcportal/pull/29)
- **Wire ugcportal into platform-gitops as a standalone ArgoCD application** (`ugcportal-4fx`, scope: gitops)
- **Gallery UI with lightbox (PhotoSwipe), on the dark surface palette** (`ugcportal-71y`, scope: gallery) — [#41](https://github.com/eiriksf-capgemini/ugcportal/pull/41)
- **Preview delivery: serve watermarked previews by opaque previewId** (`ugcportal-a2l`, scope: media) — [#36](https://github.com/eiriksf-capgemini/ugcportal/pull/36)
- **Dark surface palette for photography, with petrol demoted to accent** (`ugcportal-axu`, scope: design-system) — [#37](https://github.com/eiriksf-capgemini/ugcportal/pull/37)
- **Access control: users can only edit/delete their own UGC** (`ugcportal-bdh`, scope: security) — [#27](https://github.com/eiriksf-capgemini/ugcportal/pull/27)
- **Tags shown on gallery items, in one unified gallery (no per-tag sections)** (`ugcportal-jsc`, scope: tags) — [#46](https://github.com/eiriksf-capgemini/ugcportal/pull/46)
- **Grant/revoke the ADMIN role without hand-editing the database** (`ugcportal-lu7`, scope: auth) — [#28](https://github.com/eiriksf-capgemini/ugcportal/pull/28)
- **Upload UI: drag-and-drop page for adding images and videos** (`ugcportal-n3c`, scope: upload) — [#42](https://github.com/eiriksf-capgemini/ugcportal/pull/42)
- **Media publish state: owner-controlled publishedAt plus a public listing endpoint** (`ugcportal-r1d`, scope: media) — [#32](https://github.com/eiriksf-capgemini/ugcportal/pull/32)
- **Nothing links to the upload page** (`ugcportal-t0y`, scope: app-shell) — [#47](https://github.com/eiriksf-capgemini/ugcportal/pull/47)

### 🐛 Fixes

- **Bound total upload-path memory, not just gated image previews** (`ugcportal-05b`, scope: media) — [#38](https://github.com/eiriksf-capgemini/ugcportal/pull/38)
- **Any Google or Facebook account in the world can sign in and upload** (`ugcportal-egp`, scope: auth) — [#45](https://github.com/eiriksf-capgemini/ugcportal/pull/45)
- **Upload size cap on POST /api/media is bypassable via chunked or malformed content-length** (`ugcportal-i04`, scope: media)
- **Contrast gate mis-parses qualified colour utilities and over-reports coverage** (`ugcportal-j4j`, scope: design-system) — [#39](https://github.com/eiriksf-capgemini/ugcportal/pull/39)
- **Map watermark overload to 503 + Retry-After in the upload route** (`ugcportal-u7g`, scope: media) — [#35](https://github.com/eiriksf-capgemini/ugcportal/pull/35)

### ⚡ Performance

- **Concurrency gate for watermark preview generation** (`ugcportal-e86`, scope: media) — [#31](https://github.com/eiriksf-capgemini/ugcportal/pull/31)

### 📝 Documentation

- **Legal review: are the checklist questions sufficient now the subject is an uploader, not an account?** (`ugcportal-9cs`, scope: legal) — [#44](https://github.com/eiriksf-capgemini/ugcportal/pull/44)
- **Record best-suited model tier per bead (model/model_effort/model_why metadata)** (`ugcportal-naa`, scope: process) — [#20](https://github.com/eiriksf-capgemini/ugcportal/pull/20)
- **Handoff and working notes for the v0.4.0 build phase** (`ugcportal-r7t`, scope: process) — [#49](https://github.com/eiriksf-capgemini/ugcportal/pull/49)

### ♻️ Refactoring

- **Re-anchor the resale-rights gate from Instagram accounts to uploaders/uploads** (`ugcportal-vsm`, scope: rights) — [#40](https://github.com/eiriksf-capgemini/ugcportal/pull/40)

### 🧪 Tests

- **Scope vitest to first-party tests so agent worktrees don't pollute the run** (`ugcportal-97y`, scope: ci) — [#30](https://github.com/eiriksf-capgemini/ugcportal/pull/30)

### 🏗️ Build & CI

- **Add CI check enforcing package.json/package-lock.json version consistency** (`ugcportal-0hc`, scope: ci) — [#22](https://github.com/eiriksf-capgemini/ugcportal/pull/22)
- **Extend guard-sensitive-files CI check to cover CLAUDE.md** (`ugcportal-25x`, scope: ci) — [#21](https://github.com/eiriksf-capgemini/ugcportal/pull/21)
- **Assemble Tekton Pipeline (build, push, deploy)** (`ugcportal-720`, scope: deploy)
- **Write production Dockerfile for Next.js app (multi-stage build)** (`ugcportal-9rt`, scope: infra) — [#23](https://github.com/eiriksf-capgemini/ugcportal/pull/23)
- **Deploy via Tekton pipeline to Kubernetes cluster** (`ugcportal-cd8`, scope: deploy)
- **Kubernetes manifests: remaining gaps not covered by the platform-gitops wiring** (`ugcportal-j4d`, scope: infra)
- **Tekton Tasks beyond the image build (lint, test) -- if the platform pattern should have them** (`ugcportal-zdn`, scope: deploy)

### 🔧 Chores

- **Global bead-template skill states the superseded round-4 rule** (`ugcportal-234`, scope: process)
- **Product decision: Meta Platform Terms vs selling media fetched via the Instagram Graph API** (`ugcportal-2eh`, scope: legal)
- **Stopping rule for review iteration: severity gate, round cap, scope freeze** (`ugcportal-2yj`, scope: process) — [#43](https://github.com/eiriksf-capgemini/ugcportal/pull/43)
- **Provision container image registry** (`ugcportal-4ar`, scope: infra)
- **Harness-level AI cost: subagents inherited Opus, context rent, and parked-session cache rewrites** (`ugcportal-9ak`, scope: process) — [#48](https://github.com/eiriksf-capgemini/ugcportal/pull/48), [#50](https://github.com/eiriksf-capgemini/ugcportal/pull/50)
- **Move bead-template skill to the global skills dir** (`ugcportal-j7h`, scope: process) — [#24](https://github.com/eiriksf-capgemini/ugcportal/pull/24)
- **Legal/Compliance review: resale rights per connected Instagram account** (`ugcportal-zec`, scope: legal) — [#26](https://github.com/eiriksf-capgemini/ugcportal/pull/26)

## v0.3.0 - 2026-09-18

### ✨ Features
- **Add bead-template skill: enforce the required bead requirements form** (`ugcportal-pds`, scope: process) — [#14](https://github.com/eiriksf-capgemini/ugcportal/pull/14)
- **Add release-notes skill: bd + PR links, multi-PR-per-bead, semver bump** (`ugcportal-f7d`, scope: release-tooling) — [#13](https://github.com/eiriksf-capgemini/ugcportal/pull/13)
- **Media upload API (image + video, auth-gated)** (`ugcportal-8wa`, scope: media) — [#16](https://github.com/eiriksf-capgemini/ugcportal/pull/16)
- **cut-release: publish a GitHub Release alongside the changelog** (`ugcportal-12n`, scope: release-tooling) — [#17](https://github.com/eiriksf-capgemini/ugcportal/pull/17)

### 🐛 Fixes
- **Fix CI: typecheck runs before build, so Next's generated route types don't exist yet** (`ugcportal-63m`, scope: ci) — [#15](https://github.com/eiriksf-capgemini/ugcportal/pull/15)

### 🏗️ Build & CI
- **Enforce conventional-commit PR titles + document semver policy** (`ugcportal-8a3`, scope: release-tooling) — [#12](https://github.com/eiriksf-capgemini/ugcportal/pull/12)

### 🔧 Chores
- **Track token cost (tokens_impl/tokens_qa) as bead metadata** (`ugcportal-r9q`, scope: process) — [#17](https://github.com/eiriksf-capgemini/ugcportal/pull/17)

## v0.2.0 - 2026-09-18

### ✨ Features
- **Facebook OAuth via Auth.js (localhost redirect for dev)** (`ugcportal-3zj`, scope: auth) — [#4](https://github.com/eiriksf-capgemini/ugcportal/pull/4)
- **Google OAuth via Auth.js (localhost redirect for dev)** (`ugcportal-3vy`, scope: auth) — [#6](https://github.com/eiriksf-capgemini/ugcportal/pull/6)
- **Set up user/session data model** (`ugcportal-9s2`, scope: auth)
- **Build petrol blue design system (color tokens, Tailwind theme)** (`ugcportal-eh5`, scope: design-system) — [#5](https://github.com/eiriksf-capgemini/ugcportal/pull/5), [#7](https://github.com/eiriksf-capgemini/ugcportal/pull/7)
- **Add pr-review-merge skill: automated PR review, approve, and merge** (`ugcportal-ffa`, scope: automation) — [#11](https://github.com/eiriksf-capgemini/ugcportal/pull/11)

### 🐛 Fixes
- **Local S3-compatible storage emulation (MinIO) for dev** (`ugcportal-aeb`, scope: storage) — [#8](https://github.com/eiriksf-capgemini/ugcportal/pull/8)

### 🏗️ Build & CI
- **GitHub Actions CI: lint, typecheck, build quality gates on PRs** (`ugcportal-zo9`, scope: ci) — [#9](https://github.com/eiriksf-capgemini/ugcportal/pull/9)

### 🔧 Chores
- **Scaffold Next.js app (TS, Tailwind, shadcn/ui)** (`ugcportal-6ak`, scope: repo)

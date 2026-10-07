# Changelog

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

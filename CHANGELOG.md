# Changelog

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

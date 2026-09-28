# Changelog

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

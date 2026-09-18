# Changelog

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

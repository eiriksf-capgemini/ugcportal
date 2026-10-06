# Front page "after" screenshot — v0.6.0 UX epic (ugcportal-qqnt)

K1 evidence for `ugcportal-qqnt` (all five children merged): an "after"
screenshot of `/` and the K1 assertions checked against the running app.

- **Commit**: `origin/main` @ `3a8b1ec735928552a64aa3de3852fba53bfd65c5`
  (worktree `docs/ugcportal-qqnt-after-screenshot`, created off `origin/main`
  with no other changes applied before the screenshot was taken)
- **Viewport**: 1440x900, device scale factor 1, Chromium (Playwright 1.63.0)
- **Visitor state**: signed out, no session cookie
- **Database**: worktree-local SQLite (`file:./e2e-after.db`), migrated with
  `prisma migrate deploy` — never `main`'s `dev.db`, never `db push`
- **Server**: a **production build** (`npm run build`, then `npx next start -p
  3000`), not `next dev` — see "Production build vs. dev server" below for why
  this was redone and the exact commands
- **Screenshot**: `docs/process/front-page-after-v0.6.0-2026-10-06.png`

## What the screenshot shows

An empty gallery (no published media seeded): one-row header (brand mark +
wordmark, `Gallery` / `About` nav, a single `Sign in` button), the hero with
its 25-ish-word lead and one filled primary CTA ("See the portfolio"), the
hero's right-hand visual showing the two *neutral fallback tiles*
(`data-home-hero-visual-fallback`, not `data-home-hero-decoration` — that
marker is gone) since there are zero portfolio pieces to fill the three
slots, and the empty-state panel ("Nothing is published yet.") with one
outline secondary button, fully visible above the footer — not clipped.

A second shot with three portfolio-tagged published items was attempted by
reusing `e2e/seeded/front-page-hero-portfolio.spec.ts`'s seed/cleanup SQL
directly (same ids, same `_MediaToTag` link to the existing
`tagseed00portfolio` row) against a running `next dev` on this worktree's
database — this was cheap (a few seconds) and did produce the expected
markup: three real `<img>` elements inside `[data-home-hero-visual]`, alt
text in the newest-first order the spec asserts, and zero
`data-home-hero-decoration` / `data-home-hero-visual-fallback` elements. It
is **not** included as a PNG here: this worktree has no object storage
configured (no `S3_*` env vars — `next dev`'s own startup log warns
`[storage] Object storage ... is misconfigured`), so the `<img>` elements'
`src` (served through `/api/media/preview/[previewId]`) resolve to broken
images rather than rendered photographs, which would misrepresent the
shipped page as "broken" when the gap is this environment's storage config,
not the epic's code. The markup-level check above stands in for that shot.

## Production build vs. dev server

The first pass of this screenshot was taken against `next dev`, which stamps
a Next.js dev-tools overlay badge ("N · 2 Issues", bottom-left) onto every
page — a dev-only affordance that would never appear on the shipped
production page, so it misrepresented what a real visitor sees. Retaken
against a production build instead:

```bash
npm run build
. ./scripts/ci-placeholder-env.sh
AUTH_SECRET=$AUTH_SECRET_PLACEHOLDER \
AUTH_GOOGLE_ID=$AUTH_GOOGLE_ID_PLACEHOLDER \
AUTH_GOOGLE_SECRET=$AUTH_GOOGLE_SECRET_PLACEHOLDER \
AUTH_FACEBOOK_ID=$AUTH_FACEBOOK_ID_PLACEHOLDER \
AUTH_FACEBOOK_SECRET=$AUTH_FACEBOOK_SECRET_PLACEHOLDER \
DATABASE_URL=file:./e2e-after.db \
npx next start -p 3000   # killed by exact PID afterwards
```

(`AUTH_*_PLACEHOLDER` values come from `scripts/ci-placeholder-env.sh`, the
same placeholder auth env CI's own Build step loads, mapped to the real
`AUTH_*` names the way `.github/workflows/ci.yml`'s "Load placeholder auth
env vars" step does.) `next start` printed one warning —
`"next start" does not work with "output: standalone" configuration. Use
"node .next/standalone/server.js" instead.` — because `next.config.ts` sets
`output: "standalone"`; the server still started, bound the port, and served
`/` with a `200`, and a full `node_modules` is present in this worktree (not
the pruned standalone bundle `next start` warns is missing), so this is the
closest production-equivalent render reasonably reachable here without a
separate standalone-server run.

**Pixel-level comparison against the original dev screenshot** (1440x900,
same chromium build, both diffed via an in-browser canvas pixel compare):
7,800 of 1,296,000 pixels differ (0.6%). A diff-mask visualization shows
every differing pixel is one of exactly two things: (1) the dev-overlay
badge's rounded-rectangle footprint, bottom-left — gone in the production
shot, as expected; (2) a handful of 1px edge/anti-aliasing pixels along the
rounded corners of the two decorative hero fallback tiles (top-right),
consistent with sub-pixel rendering/timing variance between two independent
screenshot captures rather than any layout, copy, colour, or content change.
**No other part of the page differs between the dev and production
renders.**

## Dev-overlay issues observed

Per request, before stopping the dev server for good a second time, `/` was
reloaded once more under `next dev` with Playwright's `page.on('console')`
and `page.on('pageerror')` wired up, and the overlay's "2 Issues" badge was
opened and paged through (1/2, 2/2) to read its own panel text directly.
`page.on('pageerror')` fired **zero** times — these are not uncaught
client-side exceptions. Both are **server-side `console.error` calls**
(Next's overlay labels both "Console Error" / "Server"), both from the same
underlying condition. Verbatim:

**Issue 1/2** (the message):
```
[auth][error] MissingSecret: Please define a `secret`. Read more at https://errors.authjs.dev#missingsecret
```

**Issue 2/2** (the stack trace, logged as a separate `console.error` call by
Auth.js's own logger):
```
at assertConfig (.../.next/dev/server/chunks/ssr/[root-of-the-server]__006c4a0._.js:3896:16)
    at Auth (.../.next/dev/server/chunks/ssr/[root-of-the-server]__006c4a0._.js:325:202)
    at runNextTicks (node:internal/process/task_queues:65:5)
    at listOnTimeout (node:internal/timers:644:9)
    at process.processTimers (node:internal/timers:618:7)
```
(paths abbreviated above; the raw overlay text spells out this worktree's
absolute path, e.g. `/Users/eiriksf/code/ugcportal/.claude/worktrees/qqnt-after/.next/dev/...`)

**Assessment**: this is Auth.js refusing to run without an `AUTH_SECRET`,
logged on every request — the same category as the three other
environment-config warnings `next dev`'s own startup banner already prints
in this worktree (`[legal]`, `[origin] AUTH_URL`, `[storage] S3_*`), all
because this is a fresh worktree with no `.env.local` and no secrets
configured, not something any of `ugcportal-qqnt`'s five children touched.
It is **not** a hydration error, not a `pageerror`, and had no visible effect
on the rendered page (the body text/markup matched the earlier dev
screenshot exactly). Recorded here verbatim as requested; left for the
coordinator to decide whether it warrants its own bead — this session stayed
read-only on beads per instructions.

## K1 check

> Given all five children are closed, when `/` is loaded at 1440x900 as a
> visitor, the header is one row, exactly one primary call to action is
> visible, real photographs are visible in the first viewport, and no
> sign-in control appears more than once.

- **Header is one row**: yes — brand mark, wordmark, `Gallery`/`About` nav
  and the `Sign in` button all render in a single row at this viewport.
- **Exactly one primary CTA visible**: yes — the hero's "See the portfolio"
  is the only *filled* button (`bg-petrol-100 text-surface-0`, the primary
  variant). The empty state's "See what is already finished, in the
  portfolio" uses the outline/secondary variant (`border-primary
  bg-transparent text-primary`), and the footer's "Portfolio" is a plain
  text link, not a button.
- **Real photographs visible in the first viewport**: not in this shot — the
  gallery is empty, so the hero shows the two documented neutral fallback
  tiles (`data-home-hero-visual-fallback`) instead, which is the designed
  behaviour for a zero-item gallery, not a regression. With three seeded
  portfolio items (see above), the markup does render three real `<img>`
  elements in that slot instead of fallback tiles; no visual confirmation of
  the photographs themselves was possible in this sandbox because object
  storage isn't configured here.
- **No sign-in control appears more than once**: confirmed — exactly one
  occurrence of "Sign in" in the rendered HTML (verified both visually and
  via `curl http://localhost:3000/ | grep -c 'Sign in'` → `1`).

## K2 check

> Following should never happen: a child of this epic lowers any documented
> contrast pairing below its WCAG threshold or changes the petrol tokens.
> Verified by `src/lib/design/contrast.test.ts` and
> `e2e/petrol-theme.spec.ts` passing unchanged on every child PR.

- `VITEST_MAX_FORKS=3 VITEST_MAX_THREADS=3 npx vitest run
  src/lib/design/contrast.test.ts` — **236/236 passed.**
- `UGCPORTAL_E2E_REUSE_SERVER=1 npx playwright test e2e/petrol-theme.spec.ts`
  (against this worktree's own `next dev` on port 3000) — **8/10 passed, 2
  failed.** Both failures are the "held-back cross-page check" against
  `/admin/settings/rights` (light and dark), an axe `region` violation
  ("Ensure all page content is contained by landmarks") on **Next's own
  built-in not-found page** (this app ships no custom `not-found.tsx`, and
  none of this epic's five children touch the admin settings pages). This
  reproduced consistently on a clean `origin/main` checkout
  (`3a8b1ec`), unrelated to the petrol palette or contrast tokens the test
  file's own K1/K2 assertions check (those — the home page's background and
  primary-button-fill colour values, in both light and dark, plus axe at
  desktop and 320px — all passed). This looks like a pre-existing gap on
  `main`, independent of this epic; no bead currently tracks it and none was
  filed here (read-only session, per instructions).

## Commands used (for reproducibility)

```bash
git fetch origin && git worktree add <path> -b docs/ugcportal-qqnt-after-screenshot origin/main
npm ci
npx prisma generate
DATABASE_URL=file:./e2e-after.db npx prisma migrate deploy

# final "after" screenshot: a production build, not next dev (see above)
npm run build
. ./scripts/ci-placeholder-env.sh
AUTH_SECRET=$AUTH_SECRET_PLACEHOLDER AUTH_GOOGLE_ID=$AUTH_GOOGLE_ID_PLACEHOLDER \
AUTH_GOOGLE_SECRET=$AUTH_GOOGLE_SECRET_PLACEHOLDER AUTH_FACEBOOK_ID=$AUTH_FACEBOOK_ID_PLACEHOLDER \
AUTH_FACEBOOK_SECRET=$AUTH_FACEBOOK_SECRET_PLACEHOLDER DATABASE_URL=file:./e2e-after.db \
npx next start -p 3000 &   # killed by exact PID afterwards
# screenshot taken via a short @playwright/test chromium script, 1440x900, deviceScaleFactor 1

# K2 and the dev-overlay issue readout both ran against next dev instead
# (K2's petrol-theme.spec.ts needs HMR's dev-mode behaviour; the issues
# overlay only exists in dev)
DATABASE_URL=file:./e2e-after.db PORT=3000 npm run dev &   # killed by exact PID afterwards
VITEST_MAX_FORKS=3 VITEST_MAX_THREADS=3 npx vitest run src/lib/design/contrast.test.ts
UGCPORTAL_E2E_REUSE_SERVER=1 npx playwright test e2e/petrol-theme.spec.ts
```

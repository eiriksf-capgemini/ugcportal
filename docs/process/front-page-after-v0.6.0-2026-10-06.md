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
DATABASE_URL=file:./e2e-after.db PORT=3000 npm run dev &   # killed by exact PID afterwards
# screenshot taken via a short @playwright/test chromium script, 1440x900, deviceScaleFactor 1
VITEST_MAX_FORKS=3 VITEST_MAX_THREADS=3 npx vitest run src/lib/design/contrast.test.ts
UGCPORTAL_E2E_REUSE_SERVER=1 npx playwright test e2e/petrol-theme.spec.ts
```

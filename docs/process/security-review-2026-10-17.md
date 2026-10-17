# Security review of the live surface (2026-10-17)

**Bead:** `ugcportal-5x8` (scope rewritten 2026-10-17 to the surface that is live, folding in `ugcportal-l9qx` K1 and `ugcportal-q7u3`).
**Reviewed:** `origin/main` at **74f38a2** (`git rev-parse --short HEAD` in a fresh worktree, `/tmp/wt-ugcportal-5x8`, cut from `origin/main` with `git worktree add`).
**Method in one line:** the system was run and attacked, not only read — a dev server on its own database, bucket and allowlist, seeded with signed-in sessions and fixture rows, driven with 554 HTTP requests (`grep -cE '^ (GET|POST|PUT|PATCH|DELETE) ' dev.log`), plus 13 in-process tests over the parts a dev server cannot reach without OAuth credentials, and (added in review round 1 of PR #298) 11 in-process tests over the four admin server actions no request had reached (section 3.9). Section 2 says exactly what ran, and which of its counts were corrected in review; section 6 says what did not run.
**Status:** agent-prepared review by an agent that implemented none of the controls under review (`DESIGN`: independent evaluation). Severity on every finding is assigned by the reviewer and stated per finding. Nothing here inherits a severity from a tool. This document is not legal advice.
**Not repeated:** what `docs/process/rights-system-review-2026-10-12.md` already found (its Finding 1, `ugcportal-pgpq`, fixed; its Finding 2, `ugcportal-fftr`, open) is cited in section 5 and never re-derived (K3).

---

## 0. The one-paragraph version

Every control the bead names held under every attack tried — against the running system, except the four admin server actions (`recordTriage`, `recordClearance`, `setPrice`, `disconnectInstagramAccount`), which were driven in-process with the session faked at `getSession` (section 3.9; section 6 says what that leaves out) — and the system's answers matched its own documentation in every case where a documented answer existed. A non-operator owner cannot publish (`403 not_an_operator`, before any material gate), an admin cannot touch another owner's row through any of the nine owner handlers that take a row id (`403 Forbidden` on all nine), the attestation route writes the session's user whatever the body claims, each of the four admin server actions threw `Forbidden` for an anonymous, a user-less and a USER session and wrote nothing, a refused identity's live session is deleted on its next request and its payload carries no user, the preview route answers one indistinguishable `404` for "no such id", "not yours", "not cleared", "wrong shelf" and "object gone", a `previewKey` pointing at the originals' shelf is refused even to an admin, nothing anonymous ever carried `key`, `userId`, `previewKey` or `originalName`, a clearance signed by an admin who was then demoted took its photograph off every public surface on the next request with no write to the row, and the § 9-2 and § 3.2 gates refused every ordering tried. **No finding above low.** Four lows were filed as beads (section 4): ten of the thirteen mutating API handlers rely on the `SameSite=Lax` session cookie alone where the three admin routes carry a second, same-origin lock (`ugcportal-qf9v`); `env.example` gives two contradictory answers to which address `ADMIN_BOOTSTRAP_EMAILS` judges (`ugcportal-42yh`); the Instagram callback builds its redirect from `request.url` where its two sibling admin routes use the configured origin (`ugcportal-bawz`); and the app sends no anti-framing or referrer header (`ugcportal-7ex5`). A fifth low — an alcohol-linked brand's monotone `yes` protects a slug, not a company — was driven live and recorded on its existing owner, `ugcportal-jjxt`, rather than filed twice.

---

## 1. Scope, re-derived (K1)

The bead's In-scope list names the live surface as measured on 2026-10-17. Re-derived in the worktree at 74f38a2 rather than copied from the bead:

```
$ find src/app/api -name route.ts | wc -l          15
$ find src/app -name route.ts | wc -l              16    (the 15 plus src/app/llms.txt/route.ts)
$ find src/app -name page.tsx | wc -l              13
$ grep -cE '^model ' prisma/schema.prisma          16
$ grep -cE '^enum ' prisma/schema.prisma           10
$ git grep -il stripe -- src prisma package.json | wc -l    0
$ grep -rhoE 'export async function (POST|PUT|PATCH|DELETE)' src/app/api --include=route.ts | wc -l   13   (in 10 files)
$ grep -rl isSameOriginRequest src/app/api --include=route.ts | wc -l                                  3
$ grep -rl '"use server"' src/app   -> admin/settings/users/actions.ts, admin/settings/instagram/actions.ts, admin/curation/actions.ts
```

All six figures the bead's 2026-10-17 premise note records (15, 16, 13, 16, 10, 0) reproduce. The In-scope items, in the order the sections below take them: (3.1) the sign-in allowlist and per-request revocation; (3.2) publish and sell authority; (3.3) the upload, attestation and ownership chain; (3.4) the publishability gate and `PUBLIC_MEDIA_SCOPE`; (3.5) the resale-rights, clearance, disclosure, commercial-link and alcohol gates; (3.6) the admin role-change surface and bootstrap; (3.7) watermarked preview delivery; (3.8) Instagram OAuth and token encryption; (3.9) the admin server actions of items 5 and 8 (`src/app/admin/curation/actions.ts`, `src/app/admin/settings/instagram/actions.ts`), added in review round 1. Out of scope, as the bead states: payment and fulfilment (no code: the `stripe` grep above), GDPR erasure, Instagram sync, the revenue dashboard, enumeration by the anonymous readers themselves (`ugcportal-560l`), infrastructure, and the 2026-10-12 review's own findings.

---

## 2. What was run

**The server.** `npx next dev --hostname 127.0.0.1 --port 3517` from the worktree (Next.js 16.4.0, Turbopack, "Ready in 201ms"), with an environment written for this review and nothing inherited from the shared checkout's `.env*`:

- `DATABASE_URL=file:/tmp/wt-5x8-db/review.db`, migrated with `npx prisma migrate deploy` ("All migrations have been successfully applied");
- `ALLOWED_SIGNIN_EMAILS="a@example.test,b@example.test,google:c@example.test,e@example.test,admin@example.test"`; `ADMIN_BOOTSTRAP_EMAILS` unset; `AUTH_URL=http://localhost:3517`; `AUTH_SECRET` set; no Google, Facebook or Instagram credentials (`INSTAGRAM_CLIENT_ID=dummy-ig-client`);
- `S3_ENDPOINT=http://localhost:19000` (the dev MinIO container already running on this machine), bucket `ugcportal-5x8-review`, created for the review and deleted after it with its 31 objects.

**The identities.** Sessions were minted as `Session` rows written straight into that SQLite file — the mechanism `scripts/lib/e2e-session-seeding.mjs` documents ("a session is nothing more than a `Session` row plus a cookie carrying that row's `sessionToken`") — so every request went through the real `auth()`, the real adapter and the real `enforceLiveSessionPolicy`. Eleven cookies: `alice` (`u-alice`, USER, `google:a@example.test`), `bob` (USER, `facebook:b@example.test`), `carolRightProvider` (`google:c@example.test`) and `carolWrongProvider` (`facebook:c@example.test`, against the bound entry), `admin` (`u-admin`, ADMIN), `admin2` (ADMIN, deliberately NOT in the allowlist), `revoked` (`revoked@example.test`, not listed), `legacy` (`signInProvider` and `signInEmail` both NULL, `User.email` listed), `gry` (`u-gry`, USER, `configuredHandle=gry`, `facebook:gry@sander-fjeld.no` — the committed `src/config/users.ts` identity, needing no env entry) and `gryWrongProvider` (`google:` for the same address), and a 64-zero `bogus` token.

**The rows.** 19 `Media` rows seeded by a scratch script (not committed), each with a `previews/<userId>/<uuid>.webp` key and a UUID `previewId`, covering every publish state the scope distinguishes: unpublished; published and attested; attested with `showsIdentifiablePeople=true` and no clearance, a clearance by an ADMIN, a clearance by a USER, and a clearance whose reason is three spaces; attested by somebody other than the uploader; `authorship=NEITHER`; a retired attestation version; no attestation from a non-configured uploader, from the configured `gry`, and from a user whose `configuredHandle` (`former-person`) the checked array no longer derives; `depictsAlcohol=true`; a `previewKey` under `media/` (the originals' shelf); and a `previewKey` of `previews/../media/u-alice/x.png`. Objects were put behind every `previewKey` MinIO would accept (it refuses `..`: `XMinioInvalidResourceName`), so a `200` from the preview route means bytes were served and a `404` means the route refused, not that storage was empty. Six more rows were created through the real upload route (the six `201`s in section 3.3's table), after the public-scope pass of section 3.4 had been taken.

**The in-process part.** One scratch vitest file (deleted before commit; the collected-file count in the PR's checklist is the proof) with 13 tests, all passing: the sign-in gate driven through `authConfig.callbacks.signIn` with `next-auth` mocked exactly as `src/lib/auth.test.ts` mocks it (that file, not this review, pins that the config is the one `NextAuth` was handed); `decideLiveSession`; `isBootstrapAdminSignIn`; `reconcileBootstrapAdmin` against a real migrated SQLite database (`createTemporaryDatabase` + `applyMigrations` from `src/lib/test-support/db.ts`); and `encryptSecret`/`decryptSecret`/`safeEquals`.

**Two false alarms worth recording, both the reviewer's.** The first fixture pass wrote `authorship='OWN'`, which is not a `MediaAuthorship` value (`AUTHOR | LICENSED_FROM_AUTHOR | NEITHER`); every Prisma read that joined the attestation then threw P2023 and four surfaces answered 500 (`/admin/curation`, `/media/[previewId]`, the admin's own publish, the price write). That is a fixture defect, not an application one — a row with that value cannot be written through the product (`parseAttestation` refuses it, observed below as `400 field: attestation.authorship`) — and the rows were corrected before the results below were taken, with one exception the recount in round 1 found (the last bullet of the corrections paragraph below). Second, the first role-change probe posted the header's **sign-out** action id rather than `changeUserRole`'s (both sit on the same page), which deleted the probing sessions; they were re-minted and the right action id used. Neither is a finding; both are stated so the counts in the dev log are explained: two more `Session` rows than cookies, and seven `500`s from the fixture (`/admin/curation` ×1, `/media/[previewId]` ×3, the price route ×2, the publish route ×1). The other nine `500`s in the log (sixteen in all) are `POST /admin/settings/users` — the refused server-action posts section 3.6 lists, where Next renders a thrown `Forbidden` or its own `Invalid Server Actions request` as a 500.

**Counts corrected in review round 1 (PR #298).** The round-1 review found three counts in this document that disagreed with its own tables. Each was recounted, not re-argued. The dev log, the seed script and the probe scripts were deleted after the run, so the recount reads the commands and their printed output as recorded in the reviewing agent's own transcript (agent `a4698dffec9ea7b8f`), not files that still exist:

- **The fixture's `500`s: seven, not four.** Section 6 said "Four `500`s". The tally of the dev log taken before it was deleted (`grep -E ' 500 in' dev.log`, grouped by path) printed `1 GET /admin/curation`, `3 GET /media/[previewId]`, `9 POST /admin/settings/users`, `2 POST /api/admin/curation/[id]/price`, `1 POST /api/media/[id]/publish`: sixteen in all, seven from the fixture (1 + 3 + 2 + 1) and nine from the refused role-change posts. Section 6 now says seven. The "four surfaces" above is the number of paths those seven landed on, which is probably where the four came from.
- **Upload rows: six, not five.** The upload passes printed six `201`s: three for `gry` (alt text, no alt text, attested with people) in the first pass, and three for `alice` (attested, forged parts, `NEITHER`) in the second, which ran after the sign-out mistake below had been repaired. The first pass's four `alice` uploads had answered `401`, because that mistake had deleted her session. Section 3.3's table already showed six rows.
- **Unpublished seeded rows: five, not six.** Section 3.4 said "alice, bob, admin, three more". The seed script inserted 19 `Media` rows and printed `11 cookies; 19 media rows`: 14 published, plus 5 unpublished (`m-alice-unpub`, `m-alice-noatt-unpub`, `m-bob-unpub`, `m-admin-unpub`, `m-admin-noatt`). So the 19 was right and "three more" was wrong. Section 3.4 now names the five.
- **One pass predates the fixture correction.** Section 2 used to say the rows were corrected "before any result below was taken". That was not true of the public-scope pass in 3.4. The served-7 feed, the per-fixture served/withheld list and the 7 `/sitemap.xml` item URLs were all read in the same batch as the three `/media/[previewId]` `500`s, before `UPDATE MediaAttestation SET authorship='AUTHOR' WHERE authorship='OWN'` ran. The scope's only authorship test is `authorship: { not: MediaAuthorship.NEITHER }` (`src/lib/publishability.ts:454`), and `OWN` passes it exactly as `AUTHOR` does, so reading that clause gives the same served set on the corrected rows. That is a reading of the code, not a measurement: the whole pass was not re-run after the correction. Later passes did re-check single rows in the feed, and the item pages (status `200`/`404`) were re-read after it.
- **A pointer, not a count.** Section 3.6's S2 cited `docs/access-control.md` "lines 772–783" for the bootstrap statement. At 74f38a2 those lines are the `ugcportal-mzr` paragraph about re-judging a live session. The citation now points at the two passages that state the bootstrap rule and quotes them.

---

## 3. Per item: what was attempted, what happened

Every status below was read off a `curl` against the server above unless marked *in-process*. Where the bead names a target, it is quoted.

### 3.1 Sign-in allowlist and per-request session revocation

*Target: "break the sign-in allowlist and per-request session revocation".*

**The gate, driven through the wired callback** (in-process, 13 tests, scratch file): a listed unbound address is permitted via either provider and with case and padding (`"  A@Example.TEST "`) folded; a `google:`-bound address is permitted via `google` and `" GOOGLE "` and refused via `facebook` and `twitter`; `*@example.test`, `twitter:t@example.test` and `google:facebook:x@example.test` permit nobody and are the exact three `permittedIdentities(...).malformed` reports; `profile.email` decides and a stale listed `user.email` beside a fresh unlisted `profile.email` is refused (and the reverse permitted); `email_verified: false` and `"false"` are refused, absence is accepted; no address anywhere is refused; the callback answered a boolean on every input tried and never a string (the shape `handleAuthorized` would read as a redirect); an empty configuration refuses everyone with `no-configuration`; `isBootstrapAdminSignIn` honours the provider binding. Nothing new: these are the properties `src/lib/sign-in-policy.ts` claims, and the repository's own `src/lib/auth.test.ts` asserts the callback is wired. What this review adds is that it tried to find an input the policy and the callback disagree on, and found none.

**Revocation, live.** `GET /api/auth/session` with each cookie, then the `Session` table:

| cookie | identity on the row | answer | row afterwards |
|---|---|---|---|
| `alice` | `google:a@example.test` (listed) | `200 {"expires","user":{id,name,email,image,role}}` | kept |
| `carolRightProvider` | `google:c@example.test` against `google:c@…` | `200` with user | kept |
| `carolWrongProvider` | `facebook:c@example.test` against `google:c@…` | `200 {"expires":…}` — **no `user`** | **deleted** (`[auth] Refused a live session for user u-carol: wrong-provider` … `Revoked session sess-u-carol-…`) |
| `revoked` | `google:revoked@example.test` (not listed) | `200 {"expires"}`, no user | **deleted** |
| `gry` | `facebook:gry@sander-fjeld.no` (committed array) | `200` with user, `name: "Gry"` | kept |
| `gryWrongProvider` | `google:` for the same address | `200 {"expires"}`, no user | **deleted** |
| `legacy` | `NULL:NULL`, `User.email` listed | `200` with user (the pre-column fallback) | kept |
| `bogus` | no row | `null`, `Set-Cookie: authjs.session-token=; Max-Age=0` | — |

`SELECT userId, count(*) FROM Session GROUP BY userId` after the pass: `u-admin 1, u-admin2 1, u-alice 1, u-bob 1, u-carol 1 (google), u-gry 1 (facebook), u-legacy 1` — the three refused rows gone, their permitted siblings for the same users untouched (the unit is one session, as `live-session.ts` says). The throttle folded the burst as documented: one later refusal line read `(2 similar line(s) suppressed: not-permitted x1, wrong-provider x1)`. Over the whole run: 4 `Revoked session` lines, 2 `Refused a live session` lines.

**The payload allowlist** (`ugcportal-5gii`): the permitted body's keys are exactly `expires,user` and `user`'s exactly `email,id,image,name,role` — no `sessionToken`, `id`, `userId`, `signInProvider`, `signInEmail`, `configuredHandle`. The cookie Auth.js sets: `authjs.session-token=…; Path=/; Expires=…; HttpOnly; SameSite=Lax` (and `authjs.csrf-token`, `authjs.callback-url`, both `HttpOnly; SameSite=Lax`). `SameSite=Lax` is the fact section 3.3's finding S1 turns on.

**A demotion lands on the next request** (section 3.6 below): after `alice` (promoted to ADMIN by an admin) demoted `u-admin`, the still-live `admin` cookie answered `"role":"USER"` on its next `/api/auth/session` and `403` on the price route — the per-request `toRole(user)` re-read, observed rather than inferred.

**Result:** nothing broke. The two differences between a sign-in and a live session that `decideLiveSession`'s comment names (no fresh profile, no `unverified-email`) are the only two observed.

### 3.2 Publish and sell authority

*Target: "a non-operator reaching publish or price".*

| attempt | status | body |
|---|---|---|
| `alice` (USER, owner) `POST /api/media/m-alice-unpub/publish` | **403** | `{"error":"Publishing to the public gallery is restricted to this site's operators…","blocker":"not_an_operator"}` |
| `bob` (USER, owner) `POST …/publish` on a row with **no alt text** | **403** `not_an_operator` | the operator gate answered before the alt-text gate: a non-operator learns nothing about the row's state, as the route's comment promises |
| `gry` (USER, configured) `POST …/publish` on her own published row | **403** `not_an_operator` | configured-ness is not operator-ness on the manual route |
| `admin` (ADMIN, owner) `POST …/publish` on an attested row | **200** | `publishedAt` set; the echo carries no `key` (`grep -c '"key"'` on the body → 0) |
| `admin` (owner) on an un-attested row | **422** | `blocker: "attestation_missing"` — an admin is not exempt from the material gates on their own row |
| `admin` re-`POST` on the published row | **200** | idempotent, same timestamp |
| `alice` (owner) `DELETE …/publish` on her published row | **200** | `publishedAt: null` — unpublishing is deliberately ungated (`publish-authority.ts`, "Unpublishing is NOT gated here") |
| anon / `alice` `POST /api/admin/curation/<listing>/price` | **403** / **403** | `requireAdmin` collapses both to `Forbidden` |
| `admin`, `Origin: https://evil.example` / `Sec-Fetch-Site: cross-site` / `same-site` | **403** ×3 | `isSameOriginRequest` |
| `admin`, `Origin: http://127.0.0.1:3517` | **403** | `AUTH_URL` is `http://localhost:3517`; the comparison is against configuration, not the request's own host — the reviewer's mistake, and the right answer |
| `admin`, `Origin: http://localhost:3517`, `{"priceCents":1000}` on an untriaged listing | **422** | `{"error":"Not sellable","blocker":"triage_incomplete"}` |
| `admin`, `{"priceCents":null,"depictsPeople":false,"currency":"NOK"}` | **200** `priceCents: null` | the listing's `depictsPeople` stayed `NULL`: the triage column cannot be written through the price body |

**The one path where a non-ADMIN publishes:** `POST /api/media` by a configured uploader (`gry`, role USER) auto-published her upload (section 3.3) with no `isPublishOperator` check. That is `ugcportal-ho7j`'s recorded decision, stated in the publish route's own comment ("configured-ness, read from the `User` row, is that route's answer to 'may you make this public'"), and today the configured set (`src/config/users.ts`: Eirik, Gry) is the operator set Eirik named on `ugcportal-55nt`. Examined; not a finding. Worth one sentence for whoever adds a third person to that array: being listed there is a publish grant as well as a sign-in and a linking grant.

**Result:** held.

### 3.3 The upload, attestation and ownership chain

*Targets: "an admin acting on another owner's Media; the attestation route's actor".*

**Ownership, every handler, as an admin who does not own the row** (`m-alice-unpub`): `PATCH /api/media/[id]` 403, `DELETE /api/media/[id]` 403, `PUT …/tags` 403, `POST …/publish` 403, `DELETE …/publish` 403, `PUT …/disclosure` 403, `POST …/commercial-links` 403, `DELETE …/commercial-links?linkId=x` 403, `POST …/attestation` 403 — nine handlers, nine `{"error":"Forbidden"}`. `bob` (USER) on the same row: 403. Anonymous: 401. A non-existent id: 404. `GET /api/media` for `alice` and `bob` returned only each one's own rows, `cache-control: private, no-store`. `bob` trying to detach `alice`'s link through his own item's URL (`DELETE /api/media/<bob's id>/commercial-links?linkId=<alice's link>`): 404, link count unchanged — the three-predicate `deleteMany` the route describes.

**The attestation actor.** `bob` and `admin` on `alice`'s un-attested row: 403 each. `alice` with a body carrying `attestedByUserId: "u-bob"`, `mediaId: <another row>`, `publishedAt: "2026-01-01"` and `attestation.attestedByUserId: "u-bob"` beside the ten real fields: **201**, and the stored row is `m-alice-noatt-unpub by u-alice v2026-10-08.1` with `Media.publishedAt` still `NULL` — the actor is the session, the target is the URL, and the row is untouched, exactly the three properties `src/lib/attestation-write-paths.test.ts` holds the file to. A second POST: 409. A retired version (`2025-01-01.0`) on a fresh un-attested row: `400 {"field":"attestation.version"}`. `authorship=OWN`: `400 {"field":"attestation.authorship"}`.

**The upload route, with real bytes against real storage** (a 1600×1200 PNG made with sharp, 28,898 bytes):

| attempt | status | observed |
|---|---|---|
| anonymous | 401 | |
| `alice`, no attestation parts | 400 | `"This upload carries no rights attestation…", field: attestation.…` |
| `alice`, 9 bytes of text declared `image/png` | 415 | `"File content does not match its declared type"` — the sniff, before any write |
| `alice`, attested | **201** | body keys `id,kind,previewId,createdAt,publishedAt,originalName,previewKey,mimeType,sizeBytes,altText,caption,tags,advertisingDisclosure,commercialLinks` — no `key`, no `userId`; `publishedAt: null`; `previewKey` under `previews/`; preview: anon 404, owner 200, admin 200 |
| `alice`, with extra parts `userId=u-admin`, `key=media/u-admin/x.png`, `previewKey=media/u-admin/x.png`, `publishedAt=2026-01-01` | **201** | stored `userId=u-alice`, `key=media/u-alice/…`, `previewKey=previews/u-alice/…`, `publishedAt=null` — every forged part ignored |
| `alice`, attestation `authorship=NEITHER` | 201, `publishedAt: null` | and `admin` cannot publish it: 403 (owner gate) |
| `gry` (configured), no attestation parts, alt text | **201** | `publishedAt` set in the same transaction, `attested: false`, `publishRefusal: null`; anonymous preview **200**; present in `GET /api/public/media` |
| `gry`, no alt text | 201, `publishedAt: null` | `publishRefusal: {"error":"Add alt text before publishing this item.","field":"altText"}` |
| `gry`, WITH an attestation saying `showsIdentifiablePeople=yes` | 201, `publishedAt: null` | `publishRefusal: blocker "people_uncleared"` — a configured uploader who does answer is judged in full, as `publishability.ts` says |

The watermarked preview of the 1600×1200 upload came back `image/webp 1200×900` — `PREVIEW_MAX_SCALE 0.75` applied, under `PREVIEW_MAX_DIMENSION 1280`. The bucket, listed after `gry`'s three uploads and before `alice`'s three: 4 objects under `media/`, 21 under `previews/`; nothing under `media/` was ever requested by any response (section 3.7).

**Finding S1 (low), the same-origin second lock.** `src/lib/origin.ts` says of `isSameOriginRequest`: "a second lock rather than the only one — the session cookie is SameSite=Lax, so a cross-site POST arrives with no credentials … This exists for the day that cookie policy changes, a subdomain appears, or a handler is reached some way nobody predicted." It is called in 3 of the 10 files that export a mutating handler, covering 3 of 13 handlers — the three admin routes. Driven live with a valid owner cookie plus `Origin: https://evil.example` and `Sec-Fetch-Site: cross-site`: `DELETE …/publish` 200, `POST …/publish` 200, `PATCH /api/media/[id]` 200, `PUT …/tags` 200; the price route with the identical headers: 403. The same four requests without the cookie — which is what a browser actually sends cross-site under `SameSite=Lax` — 401. So the owner handlers are protected today by the cookie attribute alone, and on the day origin.ts names, the admin writes stay shut while the owner writes (publish, unpublish, rename, delete, tags, disclosure, links, attestation, upload) open. Family 4 (a check present at some sibling sites). **Low**, because `Lax` holds on every current browser and no bypass was demonstrated. Filed as **`ugcportal-qf9v`**, whose K3 is a scan test over every mutating handler so the eleventh is not forgotten either.

**Result:** the ownership and actor controls held on every probe; one defence-in-depth gap filed.

### 3.4 The publishability gate and `PUBLIC_MEDIA_SCOPE`

*Target: "get an unpublished or uncleared row into PUBLIC_MEDIA_SCOPE's result".*

`GET /api/public/media?limit=50` against the 19 seeded rows (14 published, 5 unpublished; none of section 3.3's uploads existed yet) served **7**, and these only:

| fixture | served? | why, per `src/lib/publishability.ts` |
|---|---|---|
| unpublished (five: `m-alice-unpub`, `m-alice-noatt-unpub`, `m-bob-unpub`, `m-admin-unpub`, `m-admin-noatt`) | withheld | `publishedAt IS NOT NULL` |
| published, attested, nobody shown | **served** | |
| published, `showsIdentifiablePeople=true`, no clearance | withheld | `people_uncleared` arm |
| … PEOPLE cleared by an ADMIN | **served** | |
| … PEOPLE "cleared" by a USER | withheld | `clearedBy.role = ADMIN` |
| … PEOPLE cleared by an ADMIN with a reason of three spaces | **served** | the known SQL/TS disagreement — `ugcportal-0epl` (open), cited not re-reported |
| published, attestation written by `u-bob` on alice's row | **served** | the second `0epl` disagreement (`attestedByUserId === Media.userId` cannot be a `where`) |
| published, `authorship=NEITHER` | withheld | |
| published, attestation version `2026-01-01.0` | withheld | `ACCEPTED_ATTESTATION_VERSIONS` |
| published, no attestation, non-configured uploader | withheld | |
| published, no attestation, `configuredHandle=gry` | **served** | `CONFIGURED_UPLOADER_UNDECLARED` (`ugcportal-ho7j`) |
| published, no attestation, `configuredHandle=former-person` | withheld | the handle is not in `CURRENT_CONFIGURED_HANDLES` (`ugcportal-lskg`) — removal from the array is enough |
| published, `depictsAlcohol=true` | withheld | the third arm (`ugcportal-pgpq`/`qnq9.11`) |
| published, `previewKey` under `media/` or with `..` | **served** by the scope | the scope does not inspect the key; the preview route does (3.7), so the tile's `<img>` 404s and no original moves |

Every served item carried exactly `id,kind,previewId,createdAt,publishedAt,altText,caption,tags,advertisingDisclosure,commercialLinks`; a scan of the whole page for `key`, `userId`, `previewKey` or `originalName` found none. `/sitemap.xml` listed the same 7 item URLs and no other. `/media/[previewId]` answered 200 for the served rows and 404 for the withheld ones (the two `0epl` cases render, as their listing does); the HTML of the published-clean row's page and of `/` was scanned and contained no `previews/`, `media/u-` or user-id string.

**A lapse after publication, driven rather than inferred** (`ugcportal-nffp`): with `u-admin` — the admin who had signed the PEOPLE clearance on `m-alice-people-ok` — set to `USER`, the anonymous preview of that row answered 404, the feed stopped listing it (`grep -c <previewId>` → 0) and its page 404'd; with the role restored, 200 / 1 / 200 again. No `Media` row was written in between.

**Result:** nothing uncleared or unpublished entered the result. The two rows that entered against the TypeScript predicate are the two `ugcportal-0epl` already enumerates and asserts in `publishability.scope-agreement.test.ts`; nothing is added to that bead by this review beyond a live confirmation.

### 3.5 The resale-rights, clearance, disclosure, commercial-link and alcohol gates

*Target: "exercise the alcohol, disclosure and commercial-link gates for a bypass".* All as `alice`, owner of the published `m-alice-pub`, unless stated.

| attempt | status | body (abridged) |
|---|---|---|
| `PUT …/disclosure` benefit `true`, `FREE_PRODUCT`, brand Riedel, no label | 400 | `An advertising label is required…`, `field: label` |
| … label `Sponsored` | 400 | `Forbrukertilsynet does not accept "sponsored" as an advertising label…` |
| … label `Annonse` , brand new, no alcohol answer | 400 | `Nobody has recorded whether this brand produces, imports or sells alcohol… an unasked question is not a no`, `field: benefitSource…` |
| … `benefitSourceAlcoholLinked: null` / `"false"` (string) | 400 / 400 | `must be true or false` |
| … `benefitSourceAlcoholLinked: true` | 400 | `This brand produces, imports or sells alcohol… (alkoholloven § 9-2)` — and **no `BenefitSource` row was minted** by any of the refusals above (`SELECT slug FROM BenefitSource` → empty) |
| … `benefitSourceAlcoholLinked: false` | **200** | brand `riedel alcoholLinked=0 by u-alice` — the beneficiary answered the brand question (the 2026-10-12 review, §5.6, observation; see S5 below) |
| re-declare `"RIEDEL "` with `alcoholLinked: true` | 400 | the `yes` is refused rather than recorded; the row stays `0` (monotone) |
| `POST …/commercial-links` to `riedel`, `https://…?aff=1`, `AWIN` | **201** | |
| … to `Vinmonopolet` (no row) | 400 | unasked; and no brand minted |
| … `http://`, `javascript:`, `https://user:pw@…` | 400 ×3 | `must use https`, `must not carry a username or password` |
| `PUT …/disclosure {"benefitReceived": false}` with the link attached | **409** | `Detach every link … first` (`ugcportal-jain`) |
| `PUT …/disclosure {"benefitReceived": null}` with the link attached | 409 | the same |
| the row in `GET /api/public/media` at this point | **withheld** | listing absent ⇒ `depictsAlcohol` unanswered ⇒ the commercial pair is withheld at read time — `ugcportal-pgpq`'s fix, observed live |
| `admin` `POST /api/admin/rights/brands/alcohol brandId=<riedel>` | 303 | `riedel alcoholLinked=1`; `alice` on the same route 403, anonymous 401 (`requireAdminAccess`) |
| attach a second link to Riedel; declare a benefit from Riedel; declare from `"Riedel."` (slug `riedel`) | 400 ×3 | `§ 9-2` |
| declare a benefit from `"Riedel Glas"` with `alcoholLinked: false` | **200** | slug `riedel-glas`, a new row — see S5 |
| with `depictsAlcohol=true` recorded on the row (via SQL, standing in for the triage write; the triage action itself is driven in 3.9): attach to the clean `riedel-glas` | 400 | `This item is recorded as showing alcohol, so no benefit, link or advertising label may be attached…`; and the row left the public set |
| `POST /api/admin/rights/decision` as `alice` / `admin` cross-site / `status=BOGUS` | 403 / 403 / 400 | |
| `admin`, `status=CLEARED`, `reason=reviewed` for `u-alice` | 303 | `ResaleRightsReview: u-alice CLEARED reviewedBy u-admin`; a non-existent uploader → `?error=rights_uploader_not_found&edit=u-nobody`, a blank reason → `?error=rights_reason_required` |

**S5 (low, owner `ugcportal-jjxt`).** `recordBrandAlcoholLinked` is monotone and admin-only (3.5 above); what it protects is `BenefitSource.slug`, which `validateBenefitSourceName` derives from a free-text name, so once an admin has recorded Riedel as alcohol-linked the owner is refused on `Riedel`, `RIEDEL ` and `Riedel.` (all `riedel`) and permitted on `Riedel Glas` (`riedel-glas`) with their own `false`. The 2026-10-12 review (§5.6) already observed that "the only person who ever answers this question is the person who wants the deal to go through" and placed it with `ugcportal-jjxt`'s separation-of-duties decision; the variant-name sidestep is that observation one spelling over, in a product whose owner, operator and admin are the same two people. Recorded on `ugcportal-jjxt` by `bd update --append-notes` with the sequence above; not filed as a new bead. Low: the control exists to make the operator ask the question, and an operator who will type `false` for `Riedel Glas` could have typed `false` for `Riedel` the first time.

**Result:** every bypass ordering tried was refused, at the write or at the read.

### 3.6 The admin role-change surface and the bootstrap

*Target: "the admin role-change surface and bootstrap".*

`changeUserRole` is a server action; its id was read off the admin page's rendered form (`$ACTION_ID_40a578fb…`) and posted back as the no-JavaScript form would.

| attempt | status | observed |
|---|---|---|
| anonymous / `alice` (USER) promoting herself / `bob` promoting alice | 500 ×3 | the action threw `Forbidden`; `RoleChange` rows: 0; roles unchanged |
| `admin`, `Origin: https://evil.example` | 500 | Next's own check: `` `x-forwarded-host` … does not match `origin` … Aborting the action``, `Invalid Server Actions request`; no write |
| `admin` promotes `u-alice` | 303 → `/admin/settings/users` | alice's **existing** session answered `"role":"ADMIN"` on its next request and `/admin/settings/users` 200 |
| `alice` (now ADMIN) demotes `u-admin` | 303 | admin's existing session: `"role":"USER"`; price route: 403 |
| the sole remaining ADMIN demotes self | 303 → `?error=last_admin` | role unchanged |
| promote a non-existent id | 303 → `?error=user_not_found` | |
| `role=USER` for an already-USER account | 303, no `?error` | and **no** `RoleChange` row (3 before, 3 after) |

The audit trail after the run: `u-alice USER->ADMIN by admin@example.test (ADMIN)`, `u-admin ADMIN->USER by a@example.test (ADMIN)`, `u-alice ADMIN->USER by a@example.test (ADMIN)` — actor from the session, never from the form. A tampered `role=SUPERUSER` was not reached in the live run (the request also carried a mismatched `Origin` and Next refused it first); `isRole` is asserted by `src/lib/roles.test.ts` and the action's `Unknown role` throw by `src/app/admin/settings/users/actions.test.ts:134`.

**Bootstrap** (in-process, against a real migrated SQLite, `ADMIN_BOOTSTRAP_EMAILS=google:boot@example.test`): a sign-in by the listed address through `facebook` → not promoted; through `google` → promoted, `RoleChange` written with `source BOOTSTRAP`; after an admin demotes that user, a later `google` sign-in → **not** re-promoted (the role-history guard); an unlisted address → never promoted; `RoleChange` count 2. These agree with `src/lib/admin-bootstrap.test.ts`; nothing was found that file does not already pin.

**The admin pages:** `/admin/settings/users`, `/admin/settings/rights`, `/admin/settings/rights/brands`, `/admin/settings/instagram`, `/admin/curation` — anonymous 404, `alice` 404, `admin` 200. `/upload` anonymous 307.

**Finding S2 (low), `env.example`.** Line 208: "It matches the email STORED ON THE USER ROW, which is not necessarily the one the provider asserts today", lines 210–212: "list the address you had BACK THEN". Line 231 of the same file: "BOTH VARIABLES NOW JUDGE THE SAME ADDRESS: the one your provider asserts on the sign-in actually happening", with "That used not to be true". The code is the second: `reconcileBootstrapAdmin` reads `currentSignInIdentity()?.signInEmail ?? user.email`. `docs/access-control.md` carries only the correct form. At 74f38a2 it is in two places: lines 800–805 ("It is **no longer** what the first-admin bootstrap matches. Since `ugcportal-t33p`, `reconcileBootstrapAdmin` judges the address *this* sign-in was permitted under") and lines 835–848 ("So: **name the identity they will arrive with**"). An operator following the stale bullet on a renamed-address deployment lists an address that never promotes — silently not happening rather than happening wrongly, hence low. Filed as **`ugcportal-42yh`**.

**Result:** held; one documentation contradiction filed.

### 3.7 Watermarked preview delivery

*Target: "get an unwatermarked original out via /api/media/preview/[previewId], src/lib/s3.ts or any listing".*

With an object behind every seeded `previewKey` MinIO accepted, `GET /api/media/preview/<previewId>` for every fixture and every viewer (anon / `bob` / `alice` the owner / `gry` / `admin`):

| fixture | anon | bob | alice (owner) | gry | admin |
|---|---|---|---|---|---|
| alice, unpublished | 404 | 404 | **200** | 404 | **200** |
| alice, published, clean | 404* | 404* | 200 | 404* | 200 |
| alice, published, people uncleared | 404 | 404 | 200 | 404 | 200 |
| alice, published, people cleared by ADMIN | **200** | 200 | 200 | 200 | 200 |
| … cleared by a USER | 404 | 404 | 200 | 404 | 200 |
| … blank reason / attested by bob (the two `0epl` rows) | 200 | 200 | 200 | 200 | 200 |
| alice, `NEITHER` / retired version / no attestation | 404 | 404 | 200 | 404 | 200 |
| gry, no attestation (configured) | 200 | 200 | 200 | 200 | 200 |
| former-person, no attestation | 404 | 404 | 404 | 404 | **200** |
| alice, `depictsAlcohol=true` | 404 | 404 | 200 | 404 | 200 |
| **`previewKey` under `media/`** (object present) | **404** | **404** | **404** | **404** | **404** |
| **`previewKey` with `..`** | 404 | 404 | 404 | 404 | 404 |
| bob, unpublished | 404 | **200** | 404 | 404 | 200 |

\* this row was unpublished by the owner in 3.2 and the feed row for it had by then gained a benefit with an unanswered alcohol question (3.5), so its anonymous 404 at this point is the read-time § 9-2 arm, not a defect; the owner and operator arms are unaffected, as shown.

That is the matrix `preview/[previewId]/route.ts` documents (anon / stranger / operator / owner: published-cleared 200/200/200/200, lapsed 404/404/200/200, unpublished-other's 404/404/200/200), observed on the real route against real storage. The two rows whose `previewKey` names the originals' shelf were refused to **everyone, the admin included**, with 40 `[media] previewKey is outside the preview prefix; refusing to serve` lines in the log over the run and the key in none of them; the response was the same `404 {"error":"Not found"}` as every other miss. `/api/media/preview/previews%2Fu-alice%2Fx.webp`, `…/media%2Fu-alice%2Fx.png` and `…/<a Media.id>`: 404 each — the only handle the route resolves is `previewId`. A served response carried `cache-control: private, no-cache`, `vary: Cookie`, `content-type: image/webp`, `x-content-type-options: nosniff`, an `etag`, no `content-length`, and bytes beginning `RIFF…WEBP`.

**ETag as an oracle:** `If-None-Match` with the row's own (sha256-of-previewId) tag on a served row → 304; the correct tag for a **withheld** row → 404, and `If-None-Match: *` on it → 404; the owner on her own unpublished row with its tag → 304 while the same request anonymous → 404. A forged validator cannot turn a refusal into a 304, as the route claims.

**Storage.** `grep -rn 'getSignedUrl\|presign' src` finds prose only; `grep -rn '\bkey: true' src` outside tests and the generated client finds one line, and it is a comment (`src/lib/media-listing.ts:131`, showing the ad-hoc select that must not be written) — `Media.key` is in no `select`. The only full-row read is `requireOwnedMedia`, and every handler that echoes its row projects through `toOwnerMedia` or `MEDIA_OWNER_SELECT` (observed: no `key` in the publish, PATCH, tags or upload bodies). An object that is missing answers the same 404 (130 `preview object missing from storage` lines during the fixture pass before objects were put, each answered `404 {"error":"Not found"}`).

**Result:** no input to the route, the listings or the pages produced a byte from under `media/`, and no response or log line produced a `previewKey`.

### 3.8 Instagram OAuth and token storage

*Target: "the Instagram OAuth state and token encryption".*

| attempt | observed |
|---|---|
| `alice` `GET /api/admin/instagram/connect` | 403 `Forbidden`, no redirect begun |
| `admin` `GET …/connect` | 307 to `https://www.instagram.com/oauth/authorize?client_id=…&redirect_uri=http%3A%2F%2Flocalhost%3A3517%2Fapi%2Fadmin%2Finstagram%2Fcallback&response_type=code&scope=instagram_business_basic&state=<43 chars base64url>`; `Set-Cookie: ig_oauth_state=<same>; Path=/api/admin/instagram; Max-Age=600; HttpOnly; SameSite=lax` |
| `alice` `GET …/callback?code=x&state=y` | 403 — the admin gate before any state reasoning |
| `admin`, no state cookie / cookie `abc` with `state=abd` | 307 `…/admin/settings/instagram?error=invalid_state` ×2 |
| `admin`, cookie `abc` with `state=abc` | 307 `?error=exchange_failed` (the code exchange ran against dummy credentials and failed; `InstagramAccount` rows: 0) |
| `admin`, `?error=denied`, with `Host: evil.example` | 307 `http://localhost:3517/admin/settings/instagram?error=denied` — the dev server did not reflect the forged host; the state cookie is cleared (`Max-Age=0`) on every outcome |

The token envelope (in-process): `encryptSecret` produces `v1.<iv>.<tag>.<ct>`, two seals of one token differ (random IV), the plaintext does not appear in the output, a flipped ciphertext byte or a zeroed tag fails `decryptSecret`, a `v0.` prefix fails with `Malformed`, a 16-byte key is refused with `must decode to 32 bytes`, and a different 32-byte key fails to decrypt. `safeEquals` is length-then-`timingSafeEqual`. The exchange with Meta itself was not exercised (section 6).

**Finding S3 (low).** `callback/route.ts:25` builds its redirect with `new URL(INSTAGRAM_SETTINGS_PATH, request.url)`; `rights/decision/route.ts:78` and `rights/brands/alcohol/route.ts:58` build theirs with `new URL(…, expectedOrigin() ?? request.url)`, for the reason `src/lib/origin.ts` gives: behind the TLS-terminating proxy the standalone image assumes, `request.url` is the internal host. The forged-`Host` probe above did not reproduce that on the dev server, so no open redirect is claimed — this is the functional trap one sibling of three missed (family 4), on an admin-only route. Filed as **`ugcportal-bawz`**.

**Result:** the state check and the admin gate held; the encryption does what `crypto.ts` says; one sibling inconsistency filed.

### 3.9 The admin server actions (added in review round 1)

*Targets: item 5's "the server actions in src/app/admin/curation/actions.ts" (`recordTriage`, `recordClearance`, `setPrice`) and, under item 8's token storage, `disconnectInstagramAccount` in `src/app/admin/settings/instagram/actions.ts`.*

The original run did not reach these four. The round-1 review pointed that out (F5), so they were driven afterwards. *In-process*, using the construction the repository's own action tests use (`src/app/admin/curation/actions.price.test.ts`, `actions.test.ts`, `actions.clearance.test.ts`, `src/app/admin/settings/instagram/actions.test.ts`): one scratch vitest file (deleted before commit), a real SQLite database from `createTemporaryDatabase` with the committed migrations applied by `applyMigrations` (`src/lib/test-support/db.ts`), the real Prisma client, and the real exported action. Only `@/lib/auth` (`getSession`/`auth`), `next/cache` and `next/navigation` were mocked. Each action ran against rows that one fixture (`owner-1`'s uploads, `admin-2`'s connected account) let an admin succeed on. A refusal is reported as "wrote nothing" only where the same row and the same form, sent as `admin-1`, did write. There is no "admin on another owner's row" refusal to test: these are admin-curation surfaces, so any admin acts on any uploader's row by design. Every happy path below was run on a row that the acting admin does not own.

Sessions used: anonymous (`null`); user-less (`{expires}` only, the shape a revoked live session resolves to, section 3.1); `user-1`, role USER; `admin-1`, role ADMIN; and, for the clearance only, a session claiming ADMIN for `user-1`, whose `User` row says USER.

| action | caller | outcome | written |
|---|---|---|---|
| `recordTriage` | anonymous / user-less / USER | threw `Forbidden` ×3 | no `MediaListing` created |
| `recordTriage` | `admin-1` on `owner-1`'s upload, form adding `triagedByUserId`, `actorUserId` and `userId` = `user-1` | redirect `?triage=recorded` | `triagedByUserId=admin-1`: the actor comes from the session, not the form |
| `recordTriage` | `admin-1`, one fact left unanswered | redirect `?error=unanswered&edit=…` | row unchanged |
| `recordClearance` | anonymous / user-less / USER | threw `Forbidden` ×3 | 0 clearance rows |
| `recordClearance` | session claiming ADMIN, `User` row USER | redirect `?error=clearance_actor_not_admin` | 0 rows. The write re-reads the actor's stored role. A live session cannot carry a role its row does not hold (section 3.1: the role is re-read per request), so this probes the write's own second lock, not a reachable path |
| `recordClearance` | `admin-1`, MUSIC on `owner-1`'s upload, form adding `clearedByUserId` and `actorUserId` = `user-1` | redirect `?clearance=recorded` | one row, `layer=MUSIC`, `clearedByUserId=admin-1` |
| `recordClearance` | `admin-1`, `layer=ALCOHOL` / reason of three spaces | `?error=clearance_layer_not_clearable` / `?error=clearance_reason_blank` | no further row |
| `setPrice` | anonymous / user-less / USER | threw `Forbidden` ×3 | `priceCents` still `NULL` |
| `setPrice` | `admin-1`, `owner-1`'s triaged and cleared upload, form adding `depictsPeople=true`, `depictsAlcohol=true` and `triagedByUserId=user-1` | redirect `?price=priced` | `priceCents=1000`; `depictsPeople`, `depictsAlcohol` still `false` and `triagedByUserId` still `admin-1`, so the price form cannot write triage columns (as the price route showed in 3.2) |
| `setPrice` | `admin-1`, untriaged upload | redirect `?error=price_not_sellable` | `priceCents` still `NULL` |
| `disconnectInstagramAccount` | anonymous / user-less / USER | threw `Forbidden` ×3 | account count still 1 |
| `disconnectInstagramAccount` | `admin-1` on the account `admin-2` connected; then again | returned ×2 | count 0 after the first; the second is the `deleteMany` no-op its comment promises |

11 tests, 11 passed. Each action calls `requireAdmin` before it reads a single form field, and each takes its actor from the session only. `setPrice` hands its row to the same `recordPrice` the price route calls. It refused the untriaged upload as the route did in 3.2: the route with `422 triage_incomplete`, the action with its closed-set redirect code `price_not_sellable`.

**What this construction does not show.** The session is faked at `getSession`, so these probes do not cover how a real request turns into that session: revocation, the per-request role re-read, Next's server-action `Origin` check. That is the same `requireAdmin` → `getSession` path driven live on the price route, the admin pages and `changeUserRole` (sections 3.2, 3.6 and 3.1). None of these four action ids was posted to a running server (section 6).

**Result:** held, in-process. No finding.

---

## 4. Findings

| id | finding | severity | family | owner |
|---|---|---|---|---|
| S1 | 10 of 13 mutating API handlers (every owner-facing write: upload, rename, delete, publish, unpublish, tags, disclosure, links ×2, attestation) have no same-origin check; the 3 admin routes do. Live: owner cookie + cross-site `Origin`/`Sec-Fetch-Site` → 200 on publish, unpublish, rename, tags; the price route → 403; without the cookie → 401. Held today by `SameSite=Lax` alone, the case `origin.ts` says the second lock exists for. | **low** | 4 (sibling omission) | `ugcportal-qf9v` |
| S2 | `env.example` lines 208–212 say `ADMIN_BOOTSTRAP_EMAILS` matches the address stored on the User row; line 231 and `reconcileBootstrapAdmin` say the asserted address. | **low** | 1 / 4 (a doc line contradicting its sibling) | `ugcportal-42yh` |
| S3 | The Instagram callback builds its redirect from `request.url`; its two sibling admin routes use `expectedOrigin() ?? request.url`, for the proxy reason `origin.ts` states. No open redirect demonstrated. | **low** | 4 | `ugcportal-bawz` |
| S4 | No `X-Frame-Options`, `frame-ancestors`, `Referrer-Policy` (or HSTS, which is the proxy's) on any response; `next.config.ts` has no `headers()`, no middleware exists. Clickjacking of the role-change forms is not reachable today because a cross-site iframe carries no `Lax` cookie and the admin page renders `notFound` (anonymous 404 observed). | **low** | — | `ugcportal-7ex5` |
| S5 | The brand alcohol `yes` is monotone per slug, not per company: `Riedel`/`RIEDEL `/`Riedel.` refused after the admin's `yes`, `Riedel Glas` permitted with the owner's own `false`. One spelling over from the 2026-10-12 review's §5.6 observation. | **low** | 2 (compares a derived spelling, not the thing) | `ugcportal-jjxt` (existing; noted) |

Each of S1–S4 is a bead with `severity=low` in metadata, a `discovered-from` edge to `ugcportal-5x8`, the `v0.9.0` label, and the bead-template form; `node scripts/check-bead-dispatch.mjs <id>` exited 0 for each on 2026-10-17. Nothing at critical, high or medium was found; K4's close-time check (`bd list --status=open` over the children, none at critical/high) will therefore pass on the facts as of this review, and the bead's owner — not this document — closes it.

---

## 5. Examined, and owned elsewhere or decided

Cited so the reader can see the question was asked; none is re-filed.

- **`docs/process/rights-system-review-2026-10-12.md` Finding 1** (`ugcportal-pgpq`, fixed): the publish → declare → attach ordering is now withheld at read time. Observed in 3.5: the row with a labelled benefit and a link and no listing was absent from `GET /api/public/media`. **Finding 2** (`ugcportal-fftr`, open): not touched.
- **The two states SQL cannot judge** — a whitespace-only PEOPLE reason; an attestation by someone other than the uploader — are served by the scope and refused by the predicate: `ugcportal-0epl` (open). Observed live in 3.4 and 3.7 exactly as `publishability.scope-agreement.test.ts` enumerates them.
- **MINORS not consulted by the publish gate:** `ugcportal-sbah` (open). Not re-driven.
- **A configured uploader publishes on upload without being an operator:** `ugcportal-ho7j`'s decision, `ugcportal-55nt` (open) holds the wider question. Observed in 3.3; one sentence of caution in 3.2.
- **The beneficiary answers the brand's alcohol question:** the 2026-10-12 review §5.6 and `ugcportal-jjxt`; S5 extends it by one observation and is recorded there.
- **A brand flipped to alcohol-linked after publication does not auto-unpublish:** `ugcportal-mqh8` (closed, decided). In 3.5 the row was already withheld on the unanswered-alcohol arm, so that decision's surface was not reached.
- **The owner is not told why an item vanished from the public set:** `ugcportal-bk57` (open).
- **A clearance with no end date:** `ugcportal-paa` (open).
- **Enumeration and over-serving by the anonymous readers:** `ugcportal-560l` (open), out of scope here.
- **The unpublish handler is ungated, and un-pricing is ungated:** both decided in the routes' own comments (`publish/route.ts` DELETE; `price/route.ts`), both observed.
- **Server actions and `Origin`:** Next refuses a mismatched `Origin` (`Invalid Server Actions request`, observed) and warns on a missing one (`Missing 'origin' header from a forwarded Server Actions request`, allowed) — the same allowance `isSameOriginRequest` makes for route handlers. Framework behaviour; not a finding.
- **The Instagram state cookie can be cleared mid-flow by any top-level GET to the callback with `?error=`** (the `error` branch runs before the state check and every branch clears the cookie). Denial of an in-progress connect by an admin who clicks a link; nothing is written. Not filed.

---

## 6. What was not exercised, and what to distrust

- **No OAuth exchange with Google, Facebook or Instagram.** The worktree has no provider credentials, and `bd show ugcportal-93nl` records that sign-in with an unset `AUTH_GOOGLE_ID` leaves no local signal. The sign-in gate was driven at the callback boundary in-process (13 tests) and the sessions it would have minted were written directly; the adapter linking path (`src/lib/configured-user-link.ts`, the signed-in-browser `linkAccount` branch) was **not** driven by this review and rests on `src/lib/configured-user-link.test.ts`, which drives `@auth/core`'s real `handleLoginOrRegister`. The Instagram code exchange ran against dummy credentials to its failure branch only.
- **Dev server, not `next start` behind a proxy.** Cookie `Secure`/`__Secure-` prefixes, HSTS, `x-forwarded-*` handling and the proxy case S3 describes were not observed; the forged-`Host` probe says only that the dev server did not reflect it.
- **The four admin server actions were driven in-process only** (section 3.9): `recordTriage`, `recordClearance`, `setPrice` and `disconnectInstagramAccount` ran with the session faked at `getSession`. Their action ids were never posted to the running server, so Next's server-action `Origin` check and the live session resolution in front of them were not observed for these four. Both were observed for `changeUserRole` and the price route, which go through the same `requireAdmin`. This gap was found in review (F5 of round 1). Before round 1, section 0 claimed every control held, but nothing had reached these four at all.
- **The role tamper (`role=SUPERUSER`) did not reach the action** in the live run (Next refused on `Origin` first); it rests on `src/lib/roles.test.ts` and `actions.test.ts`.
- **No load, rate or timing measurement.** The preview route's own comment says its 404s are not constant-time, and this review did not try to tell them apart by timing. No load tool was run.
- **The scratch tests and fixtures are not committed.** The 13 in-process assertions and the seed script exist in this document's prose and in the agent transcript, not in the suite; where a property matters it is named with the committed test that already pins it. The collected-file count in the PR checklist (unchanged from `main`) is what shows no scratch file was left behind.
- **The reviewer made two fixture mistakes** (section 2), both corrected before the results above were taken except 3.4's public-scope pass, which ran before the `authorship` correction (section 2's corrections paragraph says why it stands, and that it was not re-run). Seven `500`s and two extra `Session` rows in the dev log are theirs. Before review round 1 this line said four, which was wrong; section 2 has the recount.
- **Severities are one reviewer's judgement** on a two-operator instance where owner, operator and admin are the same people. On an instance that admitted a third, non-operator uploader, S1 would deserve a second look at medium: the owner handlers it names are then that uploader's.

---

## 7. Bookkeeping

Recorded on `ugcportal-5x8` by `bd update --append-notes`: this document's path, the five findings with their owners, and that nothing above low was found. Four beads filed (`ugcportal-qf9v`, `-42yh`, `-bawz`, `-7ex5`), each `discovered-from ugcportal-5x8`, each `severity=low`, each passing `scripts/check-bead-dispatch.mjs`. One note appended to `ugcportal-jjxt`. The review database, bucket, dev server and scratch files were removed (round 1's scratch test for section 3.9 too); `AGENTS.md`, which `next dev` rewrites on boot, was restored to `main`'s copy before commit.

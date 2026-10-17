# Architecture review of the system as built (2026-10-18)

**Bead:** `ugcportal-rma` (In scope rewritten 2026-10-17 to the system as built; extended 2026-10-18 with the licence-grant half of the curation surface).
**Reviewed:** `origin/main` at **f88164f** (`git rev-parse --short HEAD` in a fresh worktree, `/tmp/wt-ugcportal-rma`, cut from `origin/main` with `git worktree add`). Every count below was taken in that worktree with the command shown beside it.
**Method in one line:** the system was read, not driven — the schema, the gate libraries and every file that calls them, the route and page inventory, the server actions, the integration modules, the runtime plumbing (instrumentation, migration check, container limits, concurrency gates), the Dockerfile and compose file, and the deploy beads — and the question asked of each part was whether its placement is coherent with the rest, not whether it is correct in itself. Section 10 says what was not done.
**Status:** agent-prepared review by an agent that implemented none of the code under review (`DESIGN`: independent evaluation). Severity on every finding is assigned by the reviewer and stated per finding; nothing inherits a severity from a tool. The deploy-target section is a recommendation addressed to Eirik Sander-Fjeld; it decides nothing, closes nothing and edits no bead. This document is not legal advice.
**Not repeated:** what `docs/process/rights-system-review-2026-10-12.md` found (its Finding 1, `ugcportal-pgpq`, fixed; its Finding 2, `ugcportal-fftr`, open) is cited and not re-derived (K3), and so is what `docs/process/security-review-2026-10-17.md` (`ugcportal-5x8`, PR #298) found about the same surface.

---

## 0. The one-paragraph version

The system as built is one Next.js 16 process over one SQLite file and one S3-compatible bucket, with a rights, clearance, disclosure, commercial-link and attestation data model layered over manual uploads and an anonymous gallery. Its central architectural choice is to evaluate the law at *read time* rather than to run background jobs: the publish-rights question and the alcohol question are a `where` clause every anonymous reader spreads whole (`PUBLIC_MEDIA_SCOPE`), the sale question and the advertising-label question are re-checked in TypeScript on every render, and the request-time gates on the write paths refuse *transitions* rather than being the enforcement. Read as a system, that placement is coherent: each family has a read- or render-time arm wherever the forbidden state is a public one, the two mechanisms are split by what SQL can express, and the known places where the two disagree are filed (`ugcportal-0epl`, `ugcportal-sbah`). What the same reading shows about hosting is that the architecture is *single-process by construction* — the SQLite file, the per-process concurrency gate, the per-process upload-memory budget — and that nothing a deployment reads says so; that no backup or restore path exists for the two stores holding the only copy of the rights records, the audit trails and the paid originals; and that the production image cannot apply its own migrations on either target. Those are findings **A1, A2 and A3**, each medium and each now its own bead. The deploy-target recommendation (section 7) follows from the same facts: the Kubernetes path as shipped is a local kind cluster, not a production host; a single-replica, `Recreate`-strategy, RWO-volume pod is what SQLite forces on any cluster, which is to say the cluster buys nothing the architecture can use until the datastore changes; the recommendation to Eirik is therefore a single VPS running the existing container image under compose behind a TLS-terminating proxy, with the decision left to him and the two VPS beads untouched.

---

## 1. Scope, re-derived (K1)

Run at f88164f in `/tmp/wt-ugcportal-rma`, not copied from the bead:

```
$ grep -cE '^model ' prisma/schema.prisma                         16
$ grep -cE '^enum ' prisma/schema.prisma                          10
$ grep -n 'Resale rights' prisma/schema.prisma                    516:// Resale rights (ugcportal-0ss, re-anchored by ugcportal-vsm).
$ awk '/^\/\/ Resale rights \(ugcportal-0ss/{f=1} f && /^model /' prisma/schema.prisma | wc -l     8
$ awk '/^\/\/ Resale rights \(ugcportal-0ss/{f=1} f && /^enum /' prisma/schema.prisma | wc -l      7
$ find src/app/api -name route.ts | wc -l                         15
$ find src/app -name route.ts | wc -l                             16    (the 15 plus src/app/llms.txt/route.ts)
$ find src/app -name page.tsx | wc -l                             13
$ git grep -il stripe -- src prisma package.json | wc -l           0
$ grep -rl '"use server"' src/app | wc -l                          3
$ grep -rhoE 'export async function (POST|PUT|PATCH|DELETE)' src/app/api --include=route.ts | wc -l   13   (in 10 files)
$ ls -d prisma/migrations/*/ | wc -l                              25
$ git log --since=2026-09-15 --oneline -- prisma/schema.prisma | wc -l   23
$ git log --oneline | wc -l                                      301   (first commit 2026-09-15, last 2026-10-18, by git log --format=%ad --date=short)
$ find src -name '*.test.*' | wc -l                              238
```

All six figures the bead's 2026-10-18 premise note records (16, 10, 8+7, 15, 13, 0) reproduce. The 16-models/10-enums split is the one `docs/process/rights-system-review-2026-10-12.md` §2 settled (8 subsystem models after the banner, `RoleChange` above it counted as auth-audit, not rights); it is not re-argued here.

The In-scope items, in the order the sections below take them: (3) the data model; (4) the three gate families and their placement; (5) the application surface they sit in; (6) the integration code; (7) the deploy-target implications and the recommendation. Out of scope, as the bead states: the deferred features (checkout and fulfilment — the `stripe` grep above is 0 — the revenue dashboard, Umami, Instagram sync, GDPR erasure), the Kubernetes manifests and pipeline themselves, the security review (`ugcportal-5x8`), and re-deriving the 2026-10-12 review.

---

## 2. The system as built, in one map

**Runtime.** Next.js 16.4.0 App Router (`package.json`), React 19.2, `output: "standalone"` (`next.config.ts`), Node 20 in the image (`Dockerfile`, `ARG NODE_VERSION=20-alpine`) and in CI (`.github/workflows/ci.yml`, `node-version: 20`). Six of the 13 pages declare `dynamic = "force-dynamic"` (`grep -rl 'force-dynamic' src/app --include='page.tsx' | wc -l` → 6); the other 7 read the session or `searchParams` (`grep -c -E 'requireAdmin|getSession|searchParams'` → between 1 and 5 hits in each of the five admin pages, `/upload` and `/auth/error`), which makes them dynamic without the declaration, and the build's route table lists all 13 as `ƒ (Dynamic)`. `scripts/check-migrations.mjs`'s own header records that nothing is prerendered against the database. There is no `middleware.ts`/`proxy.ts` (`wc -l src/middleware.ts src/proxy.ts` → no such file; the security review's S4 says the same).

**Stores.** One SQLite file through Prisma 7.10's driver-adapter mode (`prisma/schema.prisma:19` `provider = "sqlite"`; `src/lib/prisma.ts` constructs `PrismaLibSql({ url: DATABASE_URL ?? "file:./dev.db" })`; `prisma/migrations/migration_lock.toml` `provider = "sqlite"`). One S3-compatible bucket through `@aws-sdk/client-s3` (`src/lib/s3.ts`: endpoint, region, path-style and credentials from `S3_*`; the comment says the same client serves MinIO in dev and DreamObjects in production), holding three prefixes: `media/` (originals, `Media.key`, never selected by any reader — `grep -rn 'key: true' src` outside tests and the generated client finds one line and it is a comment, `src/lib/media-listing.ts:131`), `previews/` (watermarked copies, `Media.previewKey`) and `rights-evidence/` (`src/lib/rights-evidence.ts`, contracts and personal data, of which only the key and a sha256 reach the database). `previews/` is served only through `GET /api/media/preview/[previewId]` (`ugcportal-5j4`'s premise; the security review's 3.7 found no other response carrying preview bytes). Sessions are database rows (Auth.js Prisma adapter, `src/lib/auth.ts`).

**Request path.** Anonymous reads go through `PUBLIC_MEDIA_SCOPE` (section 4). Owner writes go through `requireOwnedMedia` (`src/lib/media-access.ts`; six route files call it, by the call-site sweep in section 4.3). Admin writes go through `requireAdmin` (`src/lib/admin.ts`; twelve files call it) and, on the three admin route handlers, `isSameOriginRequest` as a second lock (`src/lib/origin.ts`; three files — the security review's S1 is about the ten owner handlers that do not). Admin mutations are split between **server actions** (`src/app/admin/curation/actions.ts`: `recordTriage`, `recordClearance`, `setPrice`; `src/app/admin/settings/users/actions.ts`; `src/app/admin/settings/instagram/actions.ts`) and **route handlers** where a body can be large (`src/app/api/admin/rights/decision/route.ts` carries an evidence file and says why it is not an action: `experimental.serverActions.bodySizeLimit` is global and is enforced before `requireAdmin` runs — `next.config.ts` records the same decision from the other side).

**Process model.** The following state lives in the process and nowhere else (`grep -rn --include='*.ts' -E 'globalThis|new Map\(|setInterval|process\.on\(' src/lib src/app src/instrumentation*.ts`, non-test, non-generated, plus the modules' own headers): the Prisma client singleton (`src/lib/prisma.ts`, `globalThis` outside production), the watermark concurrency gate (`src/lib/concurrency-gate.ts:10-12`, whose header says "Scope: one process. … N replicas behind a load balancer get N times this bound"), the upload-memory budget (`src/lib/upload-memory.ts`, "A single-process bound on how many bytes of upload body POST /api/media may hold at once"), every throttled log (`src/lib/throttled-log.ts`, `src/lib/live-session.ts:117-118`), and the per-request `cache()` wrappers (`grep -rln 'from "react"' src/lib src/app | xargs grep -l 'cache('`, non-test → 6 files). `src/lib/container-limits.ts` sizes the watermark pool from the cgroup rather than the host, and says why: everything Node exposes describes the host. Section 7 returns to all of this.

**Boot.** `src/instrumentation.ts` runs configuration warnings once per server start (evidence encryption, sign-in configuration, configured users, contact e-mail) and, under the Node runtime only, `src/instrumentation-node.ts` (legal pages publishable, S3 reachability with a 3-second timeout, site origin). `scripts/check-migrations.mjs` runs ahead of `next dev` and `next start` and refuses to start against a database with pending migrations; `src/lib/schema-mismatch.ts` reports the same condition after the fact when it happens anyway.

---

## 3. The data model

### 3.1 Shape

Sixteen models in three groups. **Identity** (the Auth.js adapter's four tables, with `role` and `configuredHandle` added on `User` and `signInProvider`/`signInEmail` on `Session`, each addition carrying its own comment): `User`, `Account`, `Session`, `VerificationToken`, plus `RoleChange`. **Content:** `Media`, `Tag` (implicit many-to-many), `InstagramAccount`. **Rights and disclosure** (the 8 after the banner): `ResaleRightsReview` (one per uploader), `ResaleRightsEvent` (append-only history), `MediaListing` (one sale record per upload, carrying the Part C triage, the price and since 3d7b65f the free-text `licenceTerms`), `MediaRightsClearance` (one per layer per listing), `BenefitSource` (the brand table), `MediaAdvertisingDisclosure` (1:1 with `Media`), `CommercialLink` (1:N on `Media`), `MediaAttestation` (1:1 with `Media`, the uploader's own answers).

Measured properties of the schema at f88164f:

| Property | Command | Value |
|---|---|---|
| comment lines | `grep -cE '^\s*(//\|///)' prisma/schema.prisma` over `wc -l` 1351 | 955 (71%) |
| field-level `@unique` / `@@unique` / `@@index` | `grep -c '@unique'`, `grep -c '@@unique'`, `grep -c '@@index'` | 18 / 4 / 21 |
| `onDelete` behaviours | `grep -o 'onDelete: [A-Za-z]*' prisma/schema.prisma \| sort \| uniq -c` | 11 Cascade, 2 Restrict, 1 SetNull |
| nullable booleans / non-null booleans | `grep -cE '^\s+[A-Za-z]+\s+Boolean\?'` / `grep -cE '^\s+[A-Za-z]+\s+Boolean(\s\|$)'` | 9 / 11 |

Three design decisions recur across the rights half and are stated in the schema rather than inferred here:

1. **Absence is never consent.** The 9 nullable booleans are all triage or disclosure columns (`MediaListing`'s seven facts, `MediaAdvertisingDisclosure.benefitReceived`, `BenefitSource.alcoholLinked`), and `null` on each means *unanswered*. For the seven triage facts and `alcoholLinked`, every reader lands the unanswered case on the refusing side (the 2026-10-12 review's §4 tables are the per-reader evidence); for `benefitReceived`, unanswered deliberately does nothing today — the model comment says so ("WHAT UNANSWERED DOES TODAY: nothing") and why the column is nullable anyway. The 11 non-null booleans are the 8 attestation answers — a separate table precisely so that "not asked" is the absence of the row and not a coercible `null` (`MediaAttestation`'s model comment) — plus `Tag.curated`, `ResaleRightsReview.coversFutureUploads` and `ResaleRightsEvent.selfReview`, each with a default on the refusing side.
2. **Current state cascades; history does not.** The 11 `Cascade` edges are current-state rows hanging off a `User` or a `Media`; the two append-only tables, `RoleChange` and `ResaleRightsEvent`, carry no foreign keys at all and snapshot the facts a reader needs (`subjectLabel`, `actorEmail`, `checklistVersion`, `evidenceKey`), by the argument both model comments give: an audit row that cascades away stops being an audit trail exactly when it matters. The 2 `Restrict` edges both protect `BenefitSource` from being deleted under a disclosure or a link; the 1 `SetNull` lets a deleted brand-checker leave the brand's answer standing.
3. **Enum versus table is decided per field and written down.** `Tag` and `BenefitSource` are tables (open vocabularies, identity by slug); `BenefitKind`, `CommercialLinkNetwork` (with `OTHER` + `networkOther`) and `RightsLayer` are enums (closed lists from a regulator's text or a checklist), and `RightsLayer` is additionally bound to a registry — every member must have a `TRIAGE_FACTS` entry in `src/lib/resale-rights.ts`, enforced by a test the enum comment names.

### 3.2 Three things the model's shape implies, stated at system altitude

**The anchor is `Media.userId`.** The sale gate finds the governing review by following it (`ResaleRightsReview.uploaderUserId @unique`), the attestation gate requires `attestedByUserId === Media.userId`, and the upload route writes `userId` from the session only. There is therefore no second value for a gate to compare against, which is why `ugcportal-vsm` removed the old `clearedOwnerUserId` rather than porting it. This is the single most load-bearing fact in the model, and it is enforced at the write (`POST /api/media`, the security review's 3.3 table: every forged part ignored) and read by every gate.

**A clearance needs a listing.** `MediaRightsClearance` hangs off `MediaListing`, not `Media` (`listingId`, `@@unique([listingId, layer])`), and `recordLayerClearance` returns `clearance_listing_not_found` when there is none (`src/lib/curation-clearance-write.ts:177-182`). The publish-rights gate's PEOPLE arm reads `listing.layerClearances` (`src/lib/publishability.ts:473-485`). So an operator who wants to *publish* a photograph of an identifiable person — never to sell it — must first create a sale record for it through the triage screen. Nothing visible follows from the extra row (a listing with `priceCents` null is no offer: `publicOffer` in `src/lib/sellable-media.ts`), so this is a naming and coupling wart rather than a behaviour. **Finding A4, low.**

**Two tables hold OAuth tokens under two policies.** `InstagramAccount.accessTokenEncrypted` is AES-256-GCM through `src/lib/crypto.ts`; `Account.access_token`/`refresh_token`/`id_token` (`prisma/schema.prisma:109-114`) are the Auth.js adapter's plaintext columns, and the `InstagramAccount` comment says so in as many words ("rather than the plaintext the Auth.js `Account` table stores"). The asymmetry is explained there — a standing capability over someone else's content versus a login artefact. Whether a sign-in token at rest needs the same envelope is a security question, out of this review's scope, and is noted here only so the owner of `ugcportal-5x8`'s successor can see it was seen.

### 3.3 Indexing and the one measured query

The public feed's index is partial (`@@index([createdAt, id], where: raw("publishedAt IS NOT NULL AND previewKey IS NOT NULL AND previewId IS NOT NULL"))`), and the schema comment carries the one measurement for it (200,000 rows, 1% published, ~0.6-0.7 ms → ~0.11-0.12 ms first page) together with the reason the obvious `[publishedAt, createdAt, id]` is not chosen by the planner. The index's `WHERE` is derived in a test from `PUBLIC_MEDIA_COLUMN_SCOPE`'s keys (`src/lib/media-public-feed-index-migration.test.ts`), so the feed's column filter and the index's predicate cannot drift apart silently. `CommercialLink` relies on `@@unique([mediaId, url])` to serve the by-`mediaId` read and indexes `benefitSourceId` only because `Restrict` needs it on delete; the model comment states both. Nothing here is a finding; it is recorded because it is the part of the data model a change of datastore (section 7) would have to re-measure.

---

## 4. The three gate families, and whether their placement is coherent as a system

The 2026-10-12 review's §3 table is the instrument and is not reproduced; this section asks the question that bead's rewrite put to this one: *is the placement coherent as a system?*

### 4.1 Two mechanisms, split by expressiveness

Everything that decides whether a `Media` row may be seen, sold or advertised runs through one of two mechanisms:

- **A `where` clause spread whole into every anonymous read.** `PUBLIC_MEDIA_SCOPE` (`src/lib/public-media.ts:106`) is the three column filters plus `PUBLIC_MEDIA_RIGHTS_SCOPE` (`src/lib/publishability.ts:602`), whose `AND` has three arms: a publishable attestation or a configured uploader with none; nobody identifiable shown or the PEOPLE layer cleared by a current ADMIN; and `PUBLIC_MEDIA_ALCOHOL_COMMERCE_SCOPE` (`src/lib/alcohol-commerce.ts:532`), the § 9-2 pair moved into the read path by `ugcportal-pgpq` and widened by `ugcportal-qnq9.11`. The type `MediaAnonymousScope` requires the rights half structurally, and `src/lib/public-media.consumers.test.ts` walks the tree and fails when a consumer of the constant is not covered.
- **A TypeScript predicate called on the row at render.** The sale decision, `evaluateSellability` → `isSellable` → `publicOffer` (`src/lib/resale-rights.ts`, `src/lib/sellable-media.ts`), and the advertising-label check, `isPermittedAdvertisingLabel` re-run in `toAdvertisingLabel` (`src/lib/gallery-items.ts:287-291`), which `toGalleryItem` maps every row through, and in `listPublicMedia`'s own link-stripping (`src/lib/public-media.ts`, the `commercialLinks: … ? row.commercialLinks : []` branch).

The split is not arbitrary. The sale gate needs `now` (expiry, `!(expiresAt > timeOf(now))`), a cross-relation equality (`attestedByUserId === Media.userId`), set membership against code constants (`ACCEPTED_CHECKLIST_VERSIONS`, `ACCEPTED_ATTESTATION_VERSIONS`) and a registry iteration (`TRIAGE_FACTS`); the label check needs membership in `PERMITTED_ADVERTISING_LABELS`. None of those is a Prisma filter. `ugcportal-0epl` is the exact record of what the SQL side cannot express that the TS side checks (the uploader-equality and a trimmed reason), and `src/lib/publishability.scope-agreement.test.ts` and `src/lib/alcohol-commerce.scope-agreement.test.ts` compare the two sides row by row where both exist. The TS twin of the alcohol arm, `isWithheldFromPublicRead`, has **no** non-test caller (the call-site sweep in 4.3 returns none): it exists as the oracle the agreement test compares the `where` against, which is the right use of it.

### 4.2 Request-time gates refuse transitions; they are not the enforcement

The write paths carry the refusal functions section 4.3 lists, each called where the table says: `publishGateRefusal` assembles alt text, the advertising label, the link count, the operator check and the rights predicate on a publish or an auto-publishing upload; `benefitAttachmentRefusal` and `commercialLinkDisclosureRefusal` on a disclosure or an attach; `disclosureWithdrawalRefusal` on a withdrawal; `alcoholReclassificationRefusal` on a triage write; `evaluateSellability` again on a price write. Read as a system, the property that makes this coherent is this: **for every forbidden state that is a public one, there is a read- or render-time arm as well, so a request-time gate bypassed by ordering is backstopped.** That property is the lesson of the 2026-10-12 review's Finding 1, which was exactly an ordering that reached a state the publish gate refuses; `ugcportal-pgpq` closed it by adding the read-time arm rather than by adding a fourth request-time check, and this review reads that as the right architectural move, not a patch.

The exceptions to the property are all known and owned, and listing them is the honest form of "coherent":

| Forbidden public state | Request-time refusal | Read/render-time arm | Owner |
|---|---|---|---|
| unattested, or attestation disclaims rights | publish (`publishRightsRefusal`) | scope arm 1 | — (`ugcportal-3ae`, shipped) |
| identifiable person, PEOPLE not cleared by a current ADMIN | publish | scope arm 2 | — (`3ae`/`nffp`, shipped) |
| benefit or link with the alcohol question not `false`, or alcohol recorded | disclosure, attach, publish, triage write | scope arm 3 | — (`pgpq`/`qnq9.11`, shipped) |
| declared benefit with no permitted label; link with no label | disclosure, attach, publish | `toGalleryItem` nulls a non-permitted label and drops the links | — (`qnq9.1`/`jain`/`e0jv`, shipped) |
| price shown on an unsellable item | price write | `publicOffer` inside `PUBLIC_MEDIA_SCOPE` on the item page | — (`yzo7`, shipped) |
| a minor shown, no MINORS clearance | *none on publish* | *none* (sale gate only) | `ugcportal-sbah` (open) |
| attestation signed by someone other than the uploader; whitespace-only PEOPLE reason | publish (TS predicate) | *not expressible in the scope* | `ugcportal-0epl` (open) |
| published by an operator who has since been demoted | publish (`publishOperatorRefusal`) | *none, by decision*: the operator check is about the act, and unpublishing is deliberately ungated (`src/lib/publish-authority.ts`) | decided under `ugcportal-55nt` (2026-10-09); **A5, low**, below |

The last row is the one asymmetry this review adds. A clearance signed by an admin who is later demoted lapses at read (`clearedBy.role = ADMIN` is in the scope, observed live in the security review's 3.4); a row *published* by an operator who is later demoted stays public as long as its own rights arms hold. The code says this is intended — `isPublishOperator` is "`role === ADMIN` and nothing else", the module expects the publish set to widen while the admin set does not, and the configured-uploader arm *does* re-check standing at read (`CURRENT_CONFIGURED_HANDLES`, `ugcportal-lskg`). So the system has two different answers to "the person who vouched for this no longer holds the role": re-evaluate (clearer, configured uploader) and leave standing (operator who pressed publish). Both are defensible; they are not the same answer, and the decision record covers only half of it: `docs/access-control.md:176-178` says a demoted owner "must still be able to take their own photograph down", and neither it nor any other file under `docs/` (`grep -rn -i -E 'demot|stays public|remains public' docs` → that line and three unrelated ones) says whether the photograph stays *up*. **Finding A5, low**, UNOWNED: one more sentence in that record would settle it.

### 4.3 The call-site sweep behind this section

Reach: `grep -rn --include='*.ts' --include='*.tsx' -E "\b<fn>\b" src | grep -v '\.test\.' | grep -v 'src/generated' | grep -v -E ':[0-9]+:\s*(//|\*|/\*)' | grep -v -E "^src/lib/[a-z-]+\.ts:[0-9]+:export "`, counted per file, for 27 function and constant names. The comment filter drops lines that *begin* as a comment, so a mention on a comment's continuation line can still count — the same limit the 2026-10-12 review's §3 noted — which is why the figures are given as files, not calls, and every file named was opened.

| Name | Non-test files mentioning it | What they are |
|---|---|---|
| `PUBLIC_MEDIA_SCOPE` | 6 | `public-media.ts` (feed + home page), `portfolio.ts`, `media-item.ts`, `sellable-media.ts`, `app/sitemap.ts`, `api/media/preview/[previewId]/route.ts` — the six the constant's own comment enumerates |
| `evaluateSellability` | 2 + definition | `admin/curation/page.tsx`, `curation-price-write.ts` |
| `isSellable` / `getPublicOffer` | 2 / 1 | `sellable-media.ts`; `app/media/[previewId]/page.tsx` — the price is rendered on the item page and nowhere else |
| `publishGateRefusal` | 2 | `api/media/route.ts` (auto-publish on upload), `api/media/[id]/publish/route.ts` |
| `benefitAttachmentRefusal` | 3 | disclosure route, commercial-links route, `curation-triage-write.ts` |
| `alcoholReclassificationRefusal` | 1 | `curation-triage-write.ts` |
| `commercialPublishRefusal` | 2 | `publish-gates.ts`, `curation-triage-write.ts` |
| `isWithheldFromPublicRead` | 0 | test oracle only (4.1) |
| `publishOperatorRefusal` / `isPublishOperator` | 1 / 2 | publish route; preview route's operator arm |
| `requireOwnedMedia` | 6 | every owner route under `api/media/[id]` |
| `requireAdmin` | 12 | every admin page, action and route |
| `isSameOriginRequest` | 3 | the three admin route handlers |

### 4.4 What the placement costs, and what pays for it

The cost is a maintenance tax that is real and is paid by tests rather than by types: a new rights rule needs a TS predicate, a `where` arm, an agreement test comparing them, and an entry in the consumers map. The repository has built the instruments for that (the AST scan in `public-media.consumers.test.ts`, the `is RELATION FILTERS ONLY` assertion in `public-media.lapse.test.ts`, the "keeps no top-level OR" assertion that guards the keyset-pagination trap `publishability.ts` describes), and this review found them in place for all three arms. The pay-off is the property in 4.2 and the absence of any background job: `uploaderClearanceBlocker`'s comment says "No background job is required for the gate to be correct — EXPIRED as a *status* is bookkeeping", and the 2026-10-12 review's §5.6 confirmed the `SYSTEM` transition path has no caller. The only clock-driven work the architecture would need is token refresh for the Instagram integration (`ugcportal-cud`, deferred with the integration) and housekeeping (A6, below). That is a coherent design for a system with no job runner, and section 7 notes that both deploy targets can add one when either of those becomes real.

---

## 5. The application surface

**Routes (16 `route.ts` files; 13 mutating handlers in 10 files).** Public reads: `GET /api/public/media` (its header: it "deliberately never calls `auth()`"), `GET /api/media/preview/[previewId]` (the one byte-serving path — `ugcportal-5j4`'s premise, "Nothing else in the repo serves media bytes", and the security review's 3.7: `PUBLIC_MEDIA_SCOPE` spread whole, plus an owner arm and an operator arm, proxying the object stream — `ugcportal-5j4` owns the no-CDN consequence), `/llms.txt`. Owner: `POST`/`GET /api/media` (upload, with the memory budget and the watermark gate in front of the read and the sniff before any write), `PATCH`/`DELETE /api/media/[id]`, `PUT …/tags`, `POST`/`DELETE …/publish`, `PUT …/disclosure`, `POST`/`DELETE …/commercial-links`, `POST …/attestation`. Admin: `POST /api/admin/curation/[id]/price`, `POST /api/admin/rights/decision` (the evidence upload), `POST /api/admin/rights/brands/alcohol`, `GET /api/admin/instagram/{connect,callback}`. Auth: `/api/auth/[...nextauth]`.

**Pages (13).** Anonymous: `/`, `/portfolio`, `/about`, `/media/[previewId]`, `/privacy`, `/licence`, `/auth/error`; signed-in: `/upload`; admin: `/admin/curation`, `/admin/settings/{users,rights,rights/brands,instagram}`. Plus `app/sitemap.ts`, built from `PUBLIC_MEDIA_SCOPE`.

**The curation surface** (`src/app/admin/curation/page.tsx`, 822 lines, the largest page) renders the sale gate's own blockers per item (`evaluateSellability`) beside the uploader's attestation answers (`ugcportal-vlnn`), and its three actions are the single writers of the triage facts, the layer clearances and the price-plus-licence-grant (`src/lib/curation-triage-write.ts`, `curation-clearance-write.ts`, `curation-price-write.ts`; `src/lib/licence-terms-signal.test.ts` asserts the single-writer property for the grant over the whole tree). The grant is validated on write and re-checked on read by the same function (`checkLicenceTerms`), and a stored grant the writer would refuse withdraws the whole offer rather than the grant alone — the same "do not trust that the row was written through the validator" rule the label and the price follow.

**Conventions the surface keeps consistently** (each read, none a finding): one editable column per route (`PATCH` is `originalName` only; every other field has a sub-route, and each sub-route's header says why); 401/403/404 decided in one place (`requireOwnedMedia`); every admin action calls `requireAdmin` before reading a form field and takes its actor from the session (the security review's 3.9 drove all four); a closed set of blocker codes with a full `Record` of messages so `tsc` fails on a code without a sentence (`PUBLISH_BLOCKERS`, `PUBLISH_AUTHORITY_BLOCKERS`, `TRIAGE_WRITE_REFUSALS`).

---

## 6. The integration code

**Object storage** (`src/lib/s3.ts`, 387 lines). One lazily built client; transport failures classified against `@smithy/core`'s own code lists and pinned to the installed package by a test; the upload route maps "storage unreachable" to a throttled 503. Provider-agnostic by configuration (`S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`), which `ugcportal-odx` verified is all a DreamObjects move needs. The evidence store asks for `ServerSideEncryption` only when `S3_EVIDENCE_SSE=AES256`, off by default because the dev MinIO rejects it, with a boot warning in production when neither that nor `S3_EVIDENCE_ENCRYPTED_AT_BUCKET` is set — a deployment requirement the code states three times (`rights-evidence.ts`, `instrumentation.ts`, `env.example:320`).

**Watermark pipeline** (`src/lib/watermark.ts`, 1484 lines; `upload-memory.ts`, 1171). sharp, longest edge 1280 and never more than 0.75 of the original, WebP q78, a 50 MP decompression guard, fonts from the image's `fontconfig`/`font-dejavu` (`Dockerfile`), and the two per-process budgets of section 2 sized from the cgroup. This is the most container-shaped code in the repository: `env.example:418` says "Run the container with an explicit memory limit", and on a host with no cgroup limit `detectMemoryBudget` falls back to `source: "host"` and sizes the pool from all of the machine's RAM.

**Instagram** (`src/lib/instagram.ts`, 181 lines; `crypto.ts`, 94; two admin routes; one settings page and action). The connect flow, the state cookie, the code exchange and the long-lived token sealed at rest are built; the sync job (`ugcportal-ct0`) and the refresh job (`ugcportal-cud`) are deferred to 2027-03-01. Architecturally the integration is therefore a dead end with a clock on it: `InstagramAccount.tokenExpiresAt` is written by the callback (`callback/route.ts:87`), shown on the settings page (`page.tsx:96`, "valid until …") and read by nothing else (`grep -rn tokenExpiresAt src`, non-test, non-generated → those three lines), so a connected account goes stale silently when it expires. Owned by `cud`, deferred with the rest; recorded here because it is the one place the read-time design of section 4 does not reach — a token has to be refreshed *before* it expires, and there is no job runner.

**Auth** (`src/lib/auth.ts`, 274 lines; `sign-in-policy.ts`, 1594; `live-session.ts`, 733; `configured-user-link.ts`; `admin-bootstrap.ts`). NextAuth 5 beta, Google and Facebook, the Prisma adapter wrapped three times (sign-in identity recorded on the `Session` row in its own `INSERT`, configured-user linking, schema-mismatch logging), the allowlist re-read from the environment on every request and every session judged on its own row with no extra query. `docs/access-control.md` (913 lines) is the decision record. The security review drove all of it; this review adds only that the per-request re-judgement is what lets the architecture have no session-revocation surface, and that it, too, is a read-time evaluation standing in for a job.

**Expired sessions** (**Finding A6, low**, UNOWNED). `@auth/core` deletes an expired `Session` row only when that row is presented again (`node_modules/@auth/core/lib/actions/session.js:71-72`), and the only other session delete in the application is the revocation path (`src/lib/live-session.ts:354`; `grep -rn 'session\.deleteMany' src` non-test → that one line). A session whose browser never returns stays in the file for ever. On a two-operator instance this is a few rows; it is recorded because the datastore is a single file whose growth nothing sweeps, and because it is the ordinary kind of housekeeping that a system with no job runner has to decide somewhere.

---

## 7. Deploy-target implications, and a recommendation to Eirik

This section states what the architecture as built implies for each target and recommends one. **The decision is Eirik's.** Nothing here marks the target as decided; `ugcportal-smr` and `ugcportal-2v5` are not edited, closed or re-tagged by this review; no decision bead is filed.

### 7.1 What the architecture implies, independent of target

1. **One process.** The SQLite file, the per-process gates and budgets, and the writers' own documentation of what a second client gets (`grep -rln SQLITE_BUSY src --include='*.ts'`, non-test → 7 files; `src/lib/roles.ts:45-46` "If the app ever runs more than one process against one database, re-measure before relying on this") mean the deployment unit is exactly one app process. Nothing sets `journal_mode` or `busy_timeout` (`grep -rn -i -E 'journal_mode|busy_timeout|PRAGMA' src scripts prisma7.config.ts --include='*.ts' --include='*.mjs'`, non-test, non-generated, 167 files examined → 3 lines, all prose). Horizontal scaling is not available to this architecture on any target until the datastore changes, and on today's workload — two operators, an anonymous read-mostly gallery whose first page measured ~0.12 ms at 200,000 rows — it is not needed.
2. **Deploys are a restart.** Follows from (1): a new version takes the file over from the old one, so every target has a window with no process serving. On Kubernetes that is what `ugcportal-mbq`'s `strategy: Recreate` on a `ReadWriteOnce` volume encodes; on a host it is what a supervisor's restart is.
3. **The artefact is the container image.** The watermark fonts, the non-root user, the traced `node_modules`, the cgroup-aware sizing and the separate `ugcportal-migrate` image (`scripts/build-qa-image.sh:112`, `docker build --target builder`) all live in the `Dockerfile` and `docker-compose.yml`. A bare Node process under Passenger or PM2 would have to reproduce the first four by hand and would have no migrate step at all (A3).
4. **Configuration is environment, and the boot checks are the contract.** `env.example` (the production-must-set lines: `S3_EVIDENCE_SSE`, `LEGAL_*`, `CONTACT_EMAIL`, `AUTH_URL`) plus `instrumentation.ts`'s warnings are what a deployment has to satisfy; there is no config file format to carry across.
5. **What has to survive the host:** the database file and the bucket (A2). The bucket should not share the host's fate: `ugcportal-odx`'s external object store, or any S3 service off the box, is the shape that lets a host loss be a restore of one file.
6. **What the proxy in front must do:** TLS termination and `AUTH_URL`-consistent forwarding (the three admin routes compare `Origin` against configuration, not the request host, `src/lib/origin.ts`), the framing and referrer headers the security review's S4 filed (`ugcportal-7ex5`), and — since the app has no limiter and the open bead names "the ingress in front of it" as one of two places — rate limiting (`ugcportal-9w5`).

### 7.2 The two paths as they stand on 2026-10-18

**Kubernetes.** What has shipped is in `platform-gitops`, not here: the ArgoCD application, project and workload manifests (`ugcportal-4fx`, merged), the kaniko build task (`ugcportal-ncp`, merged, image never built), the PVC/MinIO/Secret/ConfigMap wiring with `DATABASE_URL=file:/data/ugcportal.db`, `strategy: Recreate` and a 1Gi `ReadWriteOnce` PVC (`ugcportal-mbq`, merged, K1 unverified), and `up.sh` registration (`ugcportal-ybv`). Read from the beads rather than assumed: the cluster is **kind on the developer's machine** — `ugcportal-4fx` bind-mounts `/Users/eiriksf/code/ugcportal` into it and pulls from `localhost:5001`; `ugcportal-g16` (deferred) records that `kubectl cluster-info` fails because the cluster is torn down; `ugcportal-cef` (deferred) records that its `*.argocd.local` ingress host cannot be an OAuth redirect URI, so sign-in has never completed against it; `ugcportal-x0a` (deferred) records that migrations reach the PVC by `kubectl cp`. A title-and-description search of all 581 beads for "production cluster" matches none (`bd list --all --json --limit 0`, section 9's sweep). So the Kubernetes path is a **local integration environment** that works up to the image, with no production cluster named anywhere. Taking it to production means provisioning one, and by 7.1 (1)-(2) that cluster would run a single pod with `Recreate` on an RWO volume — the one shape in which a cluster adds operational surface (ingress, TLS, registry, secrets, node memory budget — `pgops-dyi` is cited in `mbq`'s notes) and returns none of the things clusters are for (replicas, rolling deploys, rescheduling with the volume).

**VPS.** What exists is two deferred beads with no code (`ugcportal-2v5`, "Passenger or PM2"; `ugcportal-smr`), both written on 2026-09-15 before the image, the compose file and the migrate image existed, and both carrying the note not to start before this review. What the backlog *already* assumes is visible in its edges: `bd dep list ugcportal-2v5 --direction=up` → **6** beads blocked on it (`5j4`, `5jd`, `9w5`, `odx`, `smr`, `xbdd`), among them rate limiting, the production OAuth redirect URIs and the index-rebuild runbook, none of which is about a VPS as such. The dependency graph has been treating the VPS as the production host since September while the decision stayed open.

### 7.3 Recommendation

**Recommended to Eirik: a single VPS running the existing container image under `docker compose`, behind a TLS-terminating reverse proxy, with the object store off the host, and the kind/ArgoCD path kept as what it already is — the local integration environment.** Concretely, and as a recommendation only:

- The unit deployed is `docker-compose.yml`'s `app` + `migrate` services with the production image (`ugcportal-fb32` already runs exactly that stack for QA), not a bare Node process. That gives 7.1 (3) for free and makes A3's mechanism the compose `migrate` service that already exists. If this is taken, `ugcportal-2v5`'s "Passenger or PM2" and `ugcportal-smr`'s pipeline are rewritten to that shape by whoever owns them — this review does not touch them.
- The bucket is DreamObjects or another S3 service off the host (`ugcportal-odx` as written), not the compose MinIO, so that A2's restore is one file plus a bucket that was never on the box.
- A1's constraint is written down before the first deploy, and A2's backup is in place before the first real upload; both are now beads.
- Rate limiting and the response headers go on the proxy (`9w5`, `7ex5` name that option), which is where a single-host deployment has them anyway.

**What would change this recommendation.** Any of: a move off SQLite to Postgres (then replicas and rolling deploys become real, and the manifests already written are the head start); traffic that makes 7.1 (1) or `ugcportal-5j4`'s byte-proxying bind, which would be measured, not assumed; or a production cluster appearing for other reasons, in which case the per-pod shape above is still what ugcportal would run on it. None of those is true at f88164f.

**What this recommendation does not do.** It does not decide, re-tag, defer, close or edit any bead; it does not choose a provider; it does not weigh cost, which this review has no numbers for and Eirik does. It gives the architectural reasons, which are the ones this bead was asked for.

---

## 8. Findings

Severity is this reviewer's. Every row above low is a bead with `severity` in its metadata and a `discovered-from` edge to `ugcportal-rma`, filed in the bead-template form and passing `node scripts/check-bead-dispatch.mjs <id>` on 2026-10-18; section 11 has the read-back. Nothing here is marked fixed or closed by this review (K3).

| id | finding | severity | owner bead |
|---|---|---|---|
| A1 | The runtime is single-process by construction — SQLite file, per-process concurrency gate and upload-memory budget, writers documenting `SQLITE_BUSY` on a second client, no journal-mode or busy-timeout setting — and nothing a deployment reads (`env.example`, `docker-compose.yml`, `docs/`) states the constraint, while the only deploy bead naming a supervisor says "Passenger or PM2". | **medium** | `ugcportal-4itq` |
| A2 | No backup or restore path for the SQLite file or the bucket, which hold the only copy of every rights, clearance, disclosure and link record, the two append-only audit tables, the paid originals and the rights evidence. 581 beads searched for "backup": 2 hits, neither about these stores; "litestream": 0. | **medium** | `ugcportal-0whr` |
| A3 | The production image copies `prisma/` but not the prisma CLI and runs `node server.js`, so `check-migrations.mjs` never runs in it; the compose `migrate` service is a working mechanism for a container host; the cluster path has `kubectl cp` (`ugcportal-x0a`, deferred, production out of scope); the VPS path has nothing; `docs/access-control.md:602` states the order with no mechanism. | **medium** | `ugcportal-ddoq` |
| A4 | A PEOPLE clearance needed only to publish requires a `MediaListing` (sale record) to exist first: `MediaRightsClearance` is keyed by `listingId` and the writer returns `clearance_listing_not_found`. No visible behaviour follows; the publish-rights gate depends on the sale subsystem's table. | low | UNOWNED |
| A5 | Two answers to "the person who vouched for this no longer holds the role": a demoted clearer's or de-configured uploader's row lapses at read; a demoted operator's published row stands. Intended per `src/lib/publish-authority.ts`, unrecorded in `docs/`. | low | UNOWNED |
| A6 | Expired `Session` rows are deleted only when presented again or revoked; nothing sweeps the rest from the single file. | low | UNOWNED |

Count of rows above low: **3**, recorded on `ugcportal-rma` with this document's path (section 11).

---

## 9. Examined, and owned elsewhere or decided

Cited so the reader can see the question was asked; none is re-filed, and none appears in the table above.

- **`docs/process/rights-system-review-2026-10-12.md` Finding 1** (`ugcportal-pgpq`, fixed by the read-time arm this review treats as the model for the whole placement) and **Finding 2** (`ugcportal-fftr`, open; the MINORS evidence requirement). Neither re-derived; both children of `ugcportal-l9qx` were compared by title against the table above before filing (K3).
- **The security review's S1-S5** (`ugcportal-qf9v`, `42yh`, `bawz`, `7ex5`, and `jjxt`'s note) — the same surface, read from the other side; 7.1 (6) relies on S1 and S4.
- **MINORS not in the publish gate:** `ugcportal-sbah` (open). The one row of 4.2's table with no read arm at all.
- **The two checks the scope cannot express:** `ugcportal-0epl` (open).
- **A clearance with no end date:** `ugcportal-paa` (open).
- **Preview bytes proxied through the app, no CDN:** `ugcportal-5j4` (deferred). A real cost on a single host; the premise it rests on (the key carries the account id) is a storage-layout decision, not a hosting one.
- **No rate limiting:** `ugcportal-9w5` (deferred), and its own text already poses the middleware-versus-proxy question 7.3 answers for the recommended shape.
- **Index-rebuilding migrations and migrate-before-deploy enforcement:** `ugcportal-xbdd` (open) and `ugcportal-if5m` (deferred); A3's bead names both and asks for a recorded decision on supersession rather than a fourth bead.
- **Playwright's `SQLITE_BUSY` under parallel workers:** `ugcportal-uwh1` (open) — the test-suite shape of A1, whose Out-of-scope line is where A1's gap was confirmed.
- **The owner is not told why an item vanished:** `ugcportal-bk57` (open). The accepted cost of every read-time arm in section 4.
- **Who may publish:** `ugcportal-55nt` (decided 2026-10-09; open). A5 is a consequence of that decision's shape.
- **Instagram token refresh and sync:** `ugcportal-cud`, `ugcportal-ct0` (deferred to 2027-03-01).
- **The anonymous surface's own review:** `ugcportal-560l` (open).
- **The in-cluster beads:** `ugcportal-mbq` (open, K1 unverified), `ncp` (open), `g16`, `cef`, `x0a` (deferred). Section 7.2 reads their notes; it does not re-verify them.

---

## 10. What this review did not do, and what to distrust in it

- **It did not run the system.** No dev server, no request, no scratch test. Where a behaviour is stated it is either read from source at f88164f with the file and line, or cited from the two sibling reviews that did drive it. The one place a behaviour of a dependency is asserted (`@auth/core` deleting an expired session only on presentation) was read from the installed package's source, not driven.
- **It did not read `platform-gitops`.** Section 7.2's account of the Kubernetes path is read from the ugcportal beads' own notes (`4fx`, `mbq`, `ncp`, `ybv`, `g16`, `cef`, `x0a`), which record what merged there and what was verified; a change in that repository since those notes would not be visible here.
- **It did not re-review any individual diff**, and it did not re-run the full suite for its own purposes (the PR's pre-review did, on the merged tree, as its checklist records).
- **The call-site counts are files, not calls**, and the comment filter can admit a continuation line (4.3). Every file in those tables was opened; the counts are a map, not a proof.
- **The deploy recommendation has no cost figures.** It weighs architecture only. Price, provider terms and Eirik's time are his inputs, not this document's.
- **Severities are one reviewer's judgement** on a system not yet in production. A1-A3 are medium because each is a pre-cutover gap whose failure, once live, is loud (a 500 rate, a lost file, every `auth()` failing) rather than silent; none is a defect in code that runs today.

---

## 11. Bookkeeping

Three beads filed on 2026-10-18, each `--deps=discovered-from:ugcportal-rma`, each `severity=medium` in metadata, each labelled `v0.9.0` (the label the sibling security review's beads carry; whether they belong in that line-up is a planning call and the label is easy to remove): `ugcportal-4itq` (A1, `cc_scope=deploy`), `ugcportal-0whr` (A2, `cc_scope=infra`), `ugcportal-ddoq` (A3, `cc_scope=deploy`). Read back after filing: `bd dep list <id>` printed `ugcportal-rma … via discovered-from` for each; `bd show <id> --json | jq -r '.[0].dependencies[] | "\(.dependency_type) -> \(.id)"'` printed `discovered-from -> ugcportal-rma` for each; `node scripts/check-bead-dispatch.mjs <id>` printed `PASS` with all 12 checks `ok` for each; `node scripts/bd-verify-metadata.mjs <id> cc_type=chore cc_scope=<scope> severity=medium model=opus` printed `VERIFIED: 4/4` for each; `bd dep list ugcportal-rma --direction=up -t discovered-from` lists exactly those three. The three lows (A4-A6) are UNOWNED by design: K2 asks for a bead per finding above low, and a low here is a sentence in a decision record or a housekeeping task that whoever picks it up can file.

Recorded on `ugcportal-rma` by `bd update --append-notes`: this document's path, the count of rows above low (3) and the three bead ids. `ugcportal-smr` and `ugcportal-2v5` were read with `bd show` and not written to.

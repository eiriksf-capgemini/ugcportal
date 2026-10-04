# Who may have an account, and therefore who may upload

Status: **provisional mechanism, settled default.** Filed and implemented for
`ugcportal-egp`. This file is the answer to "who is allowed to use this
instance?" — if you are adding a surface that lets someone put something into
the product, this is the question you do **not** get to re-answer.

## The question, and why it needs its own document

Until `ugcportal-egp`, no bead owned it. Three separate beads each shipped a
correct gate:

- `ugcportal-8wa` — `POST /api/media` answers 401 unless `session.user.id`;
- `ugcportal-n3c` — `/upload` redirects a visitor without `session.user.id`;
- `ugcportal-r1d` — publishing requires owning the row.

Every one of those is right. Together they authorise nothing, because they all
ask the same question — *are you signed in?* — and nobody had decided what
being able to sign in was supposed to mean. Google and Facebook were both
configured providers and there was **no `signIn` callback at all** — the
first-admin bootstrap ran as an Auth.js *event*, and `@auth/core`'s default
`signIn` callback returns `true`. So the real authorisation model was: anyone on
the internet with a Google or Facebook account could sign in, upload arbitrary
images and video into the object store, and publish them to the public
gallery.

The defect was invisible in every individual diff. That is why the decision is
written down here rather than only implemented: a per-PR review of the next
upload surface will not rediscover it.

## The decision

1. **Sign-in is refused by default.** With no configuration present, nobody
   can sign in. This is the part that is not up for renegotiation — the whole
   defect was that the open case was the default.
2. **The permitted set comes from configuration, never from code.** No
   hardcoded address, no domain literal, no "if the database is empty" branch.
3. **There is exactly one place that decides.** `evaluateSignIn` in
   [`src/lib/sign-in-policy.ts`](../src/lib/sign-in-policy.ts), reached two
   ways: through `isPermittedSignIn` from the `signIn` callback in
   [`src/lib/auth.ts`](../src/lib/auth.ts), and through `decideLiveSession`
   from the `session` callback in the same file (`ugcportal-mzr`, point 5
   below). Two moments, one rule — a rule that applied at the door but not on
   each request, or the reverse, would be this document's original defect one
   layer along. No other module may form its own opinion about who is allowed
   in. Gates *downstream* of sign-in (admin role, row ownership, rights
   clearance) are separate questions and stay where they are.
4. **Refusal happens at sign-in, not at each surface.** A refused identity
   never gets a `User`, `Account` or `Session` row — `@auth/core` throws
   `AccessDenied` before `handleLoginOrRegister` runs — so `auth()` returns
   null and every existing gate refuses without knowing this rule exists
   (401 from the media routes, a redirect from `/upload`, `notFound()` from
   the admin screens; each surface keeps its own answer). A new surface that
   gates on `session.user.id` is therefore already covered, and that is the
   point of putting the decision here.

   **Gate on `session.user.id` — or `hasSignedInUser` — and never on the
   session being non-null.** The two stopped being the same question with
   point 5 below: a session that is refused per-request still resolves to an
   object (`{ expires }`) with no user on it, so `if (!session)` would let a
   revoked identity through. Every surface in this app gates on the id
   today; a new one must too.

5. **And re-decided on every request** (`ugcportal-mzr`). Deciding only at
   the door meant a session minted before the rule changed kept working until
   it expired — up to 30 days. The `session` callback now asks the same
   question again on every request that resolves a session, and a session
   whose identity is no longer permitted is refused and deleted. See
   "Revoking access takes effect on the next request" below for the bound and
   for what an operator still has to do by hand.

## What is provisional

**The rule itself.** Today it is a configured allowlist of exact email
addresses (`ALLOWED_SIGNIN_EMAILS`, unioned with `ADMIN_BOOTSTRAP_EMAILS`).

Whether the right rule is an allowlist, an invite system, a domain match, or
manual approval of each request is a **product decision that has not been
made**. The allowlist is the smallest mechanism that is correct under all four
answers, chosen so that the default could be fixed immediately without
pre-empting the choice.

**The seam to replace:** three functions in
`src/lib/sign-in-policy.ts` — `permittedIdentities` (what the permitted set
is), `authorisedEmail` (which of the identity's addresses is judged) and
`evaluateSignIn` (the decision itself, which `decideSignIn`,
`isPermittedSignIn` and `decideLiveSession` are three views of). A new rule
that needs more than an email also means widening `SignInAttempt`, and one
that needs a database means making those async and both callbacks in
`src/lib/auth.ts` await them — and, because `decideLiveSession` runs on every
request, it means paying for that database read on every request too, which
is the cost the identity columns on `Session` avoid for the current rule.
Everything else, including the closed-by-default property and every
downstream gate, stays as it is.

Deliberately **not** implemented, because each would silently be the decision:

- a wildcard or domain pattern (`*@example.com` is rejected, and named in the
  log, rather than read as "anyone at this domain");
- an "allow all authenticated" escape hatch or `ALLOW_ANY_SIGNIN=true`;
- self-service sign-up with later approval.

## What an operator has to do

| Variable | Effect |
| --- | --- |
| `ALLOWED_SIGNIN_EMAILS` | Comma-separated exact addresses permitted to sign in, each optionally bound to one provider with a `google:` or `facebook:` prefix. **This is the one that decides who can upload.** |
| `ADMIN_BOOTSTRAP_EMAILS` | First-admin bootstrap (`ugcportal-lu7`). Also grants sign-in — see below. |

Neither set: nobody can sign in, and the server says so loudly at startup
(`checkSignInConfiguration` in `src/instrumentation.ts`). See `env.example`
for the full notes.

### Revoking access takes effect on the next request

**To revoke someone: remove their entry from `ALLOWED_SIGNIN_EMAILS` (and
from `ADMIN_BOOTSTRAP_EMAILS`, which grants sign-in too), then restart or
redeploy the server.** That is the whole operation. You do not also have to
delete their sessions by hand, and you do not have to wait for anything to
expire.

**The bound is the next request that resolves their session** — the next
page load, the next API call, whichever comes first. `ugcportal-mzr` chose
this (option (a) of the three it put up) over a shorter `session.maxAge`,
which only shrinks a window it can never close, and over an admin
"revoke all sessions" button, which answers a different question: what
changed is the *configuration*, and the operator who edits an environment
variable on a server has nothing to click.

How it works, in one line each:

- `callbacks.session` in [`src/lib/auth.ts`](../src/lib/auth.ts) runs on
  every request under the database session strategy. It calls
  `enforceLiveSessionPolicy` in
  [`src/lib/live-session.ts`](../src/lib/live-session.ts), which asks
  `decideLiveSession` — the same rule the sign-in gate asks — about the
  identity holding the session.
- A refused session is handed back **with no user on it**, so `auth()`
  resolves a session that no gate accepts: 401 from the media routes, a
  redirect from `/upload`, `notFound()` from the admin screens. Every gate
  that already understood "not signed in" needs no change.
- A refusal that is a *decision about the list* (`not-permitted`,
  `wrong-provider`) also **deletes that session's row**, so the cookie is
  dead rather than merely useless.
- A refusal that means *the policy cannot be evaluated* (no configuration at
  all, a session and user row with no address between them) refuses the
  request just as hard but **leaves the row alone**. That distinction is
  deliberate: losing the environment variables is an outage, not a
  revocation, and restoring them should restore the sessions rather than
  having silently logged everyone out of every device while nobody could
  sign in to notice.
- **The unit is one session, not one person.** Each session carries the
  identity that minted it — `Session.signInProvider` and
  `Session.signInEmail` — and is judged on that alone; the same person's
  other sessions are judged, separately and identically, on their own next
  request. So revoking somebody does end every session they hold, one
  request each, while a change that only affects one of their identities
  leaves the others alone. Recording this per *user* instead would mean a
  sign-in on one device could get a still-permitted session on another
  device refused and deleted — which is exactly what `ugcportal-t33p`
  (identity linking) is about to make ordinary.
- **The identity is written by the insert that creates the session.** The
  `signIn` callback puts what it just judged — provider and address — into
  an `AsyncLocalStorage` slot belonging to that request, and the adapter
  wrapper in [`src/lib/live-session.ts`](../src/lib/live-session.ts) reads
  it in `createSession`. Deliberately not a write afterwards: the Auth.js
  `signIn` event is never told which session row it is about, and two
  sign-ins by one person in the same moment (two tabs, or two providers)
  leave two indistinguishable unattributed rows. Anything that picks "the
  newest unattributed one" can label the wrong one, which is a permitted
  session refused as `wrong-provider` and deleted on its next request.
- Provider binding is honoured here too: rebinding an entry from
  `google:a@b.com` to `facebook:a@b.com` revokes the sessions minted through
  Google and leaves the Facebook ones. The columns are a denormalisation —
  the provider is also on `Account`, the address on `User` — and they earn
  it by being free to read: the session query already loads this row, so the
  per-request cost of all of the above is parsing two environment variables
  (memoised on their exact values), and **no database read beyond the one
  `auth()` was always making**. The only write is the revocation itself.
  `Account` could not answer the question anyway: it says which providers
  are linked, never which one a given session came through.
- An unrecorded identity (`NULL` — a session from before the columns
  existed, or one the migration's backfill could not attribute because the
  user had two linked providers) is treated as *unrecognised*: the provider
  fails closed against a bound entry and changes nothing for an unbound one,
  and the address falls back to `User.email`, which is what this check
  judged before the columns existed. The cost is one extra sign-in on such a
  device; the alternative, guessing, could keep a session alive through the
  provider the operator did not name.

**What an operator still has to do by hand:**

1. **Restart or redeploy** after editing the variable. The policy is read
   from the process environment on every call — the parse is memoised on the
   exact strings, so a changed value is a changed answer with no TTL to wait
   out — but a process that is still running still has the old environment.
   The "next request" bound is relative to the configuration the server
   sees.
2. **Decide whether the account should exist at all**, which this does not
   touch. A revoked identity keeps its `User`, `Account` and `Media` rows; it
   simply cannot reach anything. See step 3 of the runbook below before
   reaching for `DELETE FROM User`.
3. **Deal with what they already published.** Revocation stops future
   access; it does not unpublish media that is already in the public gallery
   or remove anything from the bucket.
4. **Audit, if you need to know who got in.** Revocation is silent by
   design on the visitor's side; the server logs each refused live session
   with the user's id and the reason.

### Deploy order: migrate first, then deploy

**Run `prisma migrate deploy` before rolling out the code that reads the new
columns.** The generated Prisma client selects every scalar column the schema
knows about, so a new client against a database that has not had
`20261004180000_add_session_sign_in_identity` applied fails
`getSessionAndUser` — which is every `auth()` call, for everybody, including
the operator, on every page. The migration itself is additive (two nullable
columns and a backfill) and is harmless to the running old code, which simply
never selects them.

### What the first deploy of the sign-in gate still needs

The one-time cleanup for the deploy that first carried `ugcportal-egp`'s gate
is still worth running, for a reason the automatic revocation above does not
cover: **it tells you who got in while the door was open.** Automatic
revocation makes those accounts harmless, not invisible, and it deletes the
sessions that are the evidence of who held one.

(It is also the fallback whenever you want sessions gone *without* changing
the allowlist — forcing everyone to sign in again after a scare, say.)

So — **look first, then revoke**, since deleting the sessions also deletes
the evidence:

1. **Audit who got in while the door was open.** Read-only. The datasource is
   `sqlite` (`prisma/schema.prisma`), so `DATABASE_URL` is a `file:` URL, not
   a connection string, and `${DATABASE_URL#file:}` is the path:

   ```bash
   DB="${DATABASE_URL:-file:./dev.db}"
   sqlite3 -header -column "${DB#file:}" \
     'SELECT u.email, u.role, COUNT(DISTINCT m.id) AS uploads,
             COUNT(DISTINCT s.id) AS sessions
        FROM User u
        LEFT JOIN Media m ON m.userId = u.id
        LEFT JOIN Session s ON s.userId = u.id
       GROUP BY u.id ORDER BY u.email;'
   ```

   The `#file:` strips the scheme, because `sqlite3` takes a path and only
   some builds accept a `file:` URI. On a remote libsql deployment, run the
   same query through that provider's shell — the query is the point, not
   the client.

   **Do not reach for `prisma db execute` here.** It is documented as "not
   meant for returning data", and it is worse than useless for an audit: a
   `SELECT` through it prints `Script executed successfully.` and no rows.
   The natural reading of that is "no accounts", at exactly the moment you
   are deciding whether anyone unwanted got in. (Verified against Prisma
   7.10. It also has no `--url` flag — it reads the datasource from
   `prisma7.config.ts`, which reads `DATABASE_URL`.)

2. **Revoke every session.** This is the part that is always correct, and it
   is enough to make the gate effective: everyone signs in again and the
   `signIn` callback decides. Since `ugcportal-mzr` the per-request check
   already refuses and deletes the sessions of anyone the list does not
   name, so this is belt-and-braces for the ones it names — and the only way
   to clear sessions you are *not* revoking. A write, so `prisma db execute`
   is fine:

   ```bash
   npx prisma db execute --stdin <<'SQL'
   DELETE FROM Session;
   SQL
   ```

3. **Then decide, per account, whether it should exist at all.**

   **Do not reflexively delete the `User` rows.** `DELETE FROM User` is not
   a narrow operation. Enumerated from `prisma/schema.prisma` as of 457323d
   (`ugcportal-vsm`, the last commit to touch it) by walking every
   `onDelete: Cascade` relation transitively from `User` — re-derive it the
   same way rather than trusting this list to have aged well:

   | Destroyed | Reached via | What is actually lost |
   | --- | --- | --- |
   | `Session` | `Session.user` | sign-in state only |
   | `Account` | `Account.user` | the OAuth link |
   | `Media` | `Media.user` | every upload record |
   | `MediaListing` | `Media` | price and sale state |
   | `MediaRightsClearance` | `MediaListing` | the clearance on each upload |
   | `ResaleRightsReview` | `ResaleRightsReview.uploader` | **the uploader's standing rights clearance**, with its `evidenceKey`/`evidenceSha256` pointers into `rights-evidence/` |
   | `InstagramAccount` | `InstagramAccount.connectedBy` | **the connected account including `accessTokenEncrypted`** — note this is whoever *ran* the connect, not a property of the account being deleted |

   The last two are the expensive ones and the least obvious: an operator
   tidying up a stranger's account can destroy the Instagram connection and a
   rights clearance that have nothing to do with that stranger's uploads. And
   none of it touches S3 — the originals and watermarked previews stay in the
   bucket with nothing referencing them.

   Nothing blocks the delete and nothing warns. `RoleChange` has no relation
   at all and `ResaleRightsEvent.reviewId` is deliberately not one, so the
   audit trail survives — pointing at rows that no longer exist.

   Leaving an unwanted account in place with no session and no way to sign in
   is the safer default; it can reach nothing.

Today this is very likely a no-op — nothing has been deployed (`ugcportal-321`)
— but it is written here because the doc is what the next operator reads, and
"the gate is live" and "nobody unwanted holds a session" are two different
facts.

Of the three ways of doing this **in code** — purging sessions on boot,
re-checking the policy per request, or shortening `maxAge` — `ugcportal-mzr`
shipped the second; see "Revoking access takes effect on the next request"
above. `session.maxAge` is still `@auth/core`'s default **30 days**
(`node_modules/@auth/core/lib/init.js:38`), and that is now only how long a
*still-permitted* session lasts without being used.

## How the email is compared

Small things, each of which has been a real bug somewhere:

- entries are split on commas, trimmed and lowercased; blank entries are
  dropped;
- an entry that is not shaped like an email address is **ignored and named**,
  at startup and on every refusal. It does not permit anybody, and it does not
  silently disappear either. Silently permitting nobody and silently
  permitting everybody are both bad, and the reporting is what keeps the first
  one from being the second one's twin;
- an entry may be **bound to one provider** (ugcportal-1551): `google:a@b.com`
  permits that address only when `account.provider` on the sign-in is
  `google`; the same address through Facebook is refused with the
  server-side reason `wrong-provider`, and the visitor sees the same Access
  denied page as every other refusal. A bare entry is unbound and keeps the
  original any-provider meaning; an unbound entry for an address overrides a
  bound one for the same address. The prefix must be one of the ids in
  `SIGN_IN_PROVIDERS` (src/lib/sign-in-policy.ts), which a test in
  src/lib/auth.test.ts pins to the providers actually configured — anything
  else (`twitter:`, a typo) is malformed and reported, not treated as unbound.
  The same syntax works in `ADMIN_BOOTSTRAP_EMAILS`, and there it binds both
  the sign-in grant and the promotion: `reconcileBootstrapAdmin` receives the
  sign-in's provider and promotes only through the one the entry names, so
  an unbound allowlist entry for the same address cannot be used to collect
  the promotion through the other provider;
- every address is optional on the Auth.js objects, so absent, empty and
  whitespace-only all normalise to `null` and are refused before any
  comparison happens — an absent address cannot match a blank list entry from
  either side, and blank entries are dropped from the list anyway;
- **the address judged is the one the provider vouched for in this exchange**,
  falling back to the stored one only when the provider asserts none (Facebook
  omits `email` unless the app was granted it). A profile asserting
  `email_verified: false` is refused rather than reconciled. Authorising
  address A while admitting address B is the "compares the wrong two things"
  family and it is the one that matters most here; preferring the freshly
  verified address keeps the verification and the authorisation about the
  same string by construction.

### If your provider email changes

You are judged on your **new** address, so **add it to
`ALLOWED_SIGNIN_EMAILS`** and you are back in. You do not have to keep the old
one listed.

One wrinkle since `ugcportal-mzr`: a session is re-judged on the address
recorded when it was **minted**, which is the address the provider asserted
at that sign-in (a request carries no provider profile to read a fresher one
from). So a session you opened before you changed your address is still
judged on the old one, and removing the old entry revokes it. Sign in again —
that attempt is judged on the fresh address, which is listed — and the
session that replaces it is recorded under the new address. Annoying for one
round trip, and in the safe direction. (A session minted before these columns
existed has no recorded address and falls back to `User.email`, which Auth.js
never refreshes, so it behaves exactly as the old one did.)

This is worth stating because the obvious alternative is a trap, and this
module shipped it briefly: refusing whenever the stored and asserted addresses
differ. `@auth/core` links an account by the provider's stable subject, not by
email, and **never refreshes `User.email` for an already-linked OAuth
account** (`handleLoginOrRegister` returns `userByAccount` untouched). So the
mismatch is permanent from the first address change onward, and a refusal on
it could not be cleared by any configuration — on a single-operator instance,
a permanent self-lockout of the only operator, fixable only by editing the
database.

**Known limitation, accepted:** nothing writes the new address back, so
`User.email` stays at the old value forever. It authorises nothing —
ownership is by `user.id`, admin by `role`, and sign-in by the address above
— but it is what gets *displayed and recorded*: the header
(`src/components/auth-status.tsx`), the actor on a role change
(`RoleChange.actorEmail`), the uploader label on the rights screen, and the
address `reconcileBootstrapAdmin` matches. So a bootstrap entry must name the
address that was stored when the account was created, and an audit trail may
name an address its owner no longer uses.

## How this composes with the first-admin bootstrap

`ADMIN_BOOTSTRAP_EMAILS` and `ALLOWED_SIGNIN_EMAILS` are **unioned into one
permitted set**. Consequences, both intended:

- a fresh deployment that sets only `ADMIN_BOOTSTRAP_EMAILS` still works, so
  `ugcportal-lu7` is not broken by this;
- the bootstrap **cannot** admit anyone the allowlist would refuse, because
  being listed for bootstrap is itself a grant of access — made in
  configuration, by whoever can set environment variables on the deployment,
  which is the same power `ugcportal-lu7` already documents as its trust
  boundary.

There is **no empty-database condition anywhere in this path**, and there must
never be one. "The database is empty, so let this person in and make them
admin" is an open door in disguise: an emptiable or race-able condition
becomes a bypass. `reconcileBootstrapAdmin` never asks whether the database is
empty — it asks whether *this* address is listed and whether *this* user has
no role-change history — so there is no window to arrange or race. It also
runs as an Auth.js **event**, after the `signIn` callback has already
permitted the sign-in, so it is reached only by identities that were permitted
anyway.

If the mechanism is ever replaced with one that does not naturally contain the
bootstrap list, the replacement must union it in explicitly, or bootstrap on a
fresh deployment stops working and the instance cannot get its first admin.

## What a refused visitor sees

A 302 to a first-party page at `/auth/error`
([`src/app/auth/error/page.tsx`](../src/app/auth/error/page.tsx), wired as
`pages.error`), which then answers an ordinary **200**, saying the instance is
private, that there is nothing to retry, and to ask the operator for access.

**Do not monitor this app's auth by status code.** Setting `pages.error` is
precisely what gives those statuses up. `@auth/core` serves its built-in card
with `toResponse(renderPage().error(...))`, which carries a real status; with
`pages.error` set, both of its error paths instead return
`Response.redirect()` — a 302 to an ordinary Next page that answers 200:

| Situation | Without `pages.error` | With it (this app) |
| --- | --- | --- |
| Sign-in refused | 403 (`index.js:135-141`) | 302 → 200 |
| Auth config broken | 500 (`index.js:97-106`) | 302 → 200 |

The second matters more than the first. A deployment that is missing
`AUTH_SECRET` — where **nobody can sign in at all** — used to answer 500 and
now answers a redirect to a page that renders fine, so a 5xx-keyed uptime
check calls it healthy. The user-visible trade is deliberate and good; the
monitoring consequence is not, and is the reason this is written down.

What *can* still be keyed on: the config branch only rewrites HTML `GET`s to
the auth pages, so a non-GET or a non-page action such as
`GET /api/auth/session` still answers JSON 500 (`index.js:86-88`).

A **revoked live session** sees none of this, because there is no sign-in
attempt to refuse: the person simply stops being signed in. The header
offers "Sign in" again, `/upload` redirects, the API answers 401 — and if
they do sign in again, the sign-in gate refuses them and *then* they land on
this page. The reason is logged server-side, with the user's id (not their
address — the id is already in the logs as the owner of every row they
touch).

The wording is **identical for every refusal**, and is worded to be true of
all of them. The gate distinguishes "not on the list" from "the provider would
not vouch for that address" from "nobody has configured this yet", and the
visitor is told none of it — that difference is only useful to someone probing
the configuration. The reason is logged server-side, with the email's domain
only rather than the whole address, because a log of the addresses of people
who tried to sign in is personal data this instance has no reason to keep.

What this does *not* hide, and cannot under any allowlist-shaped mechanism:
someone who controls an address can always learn whether that address is
permitted, by trying it. What is hidden is everything about *other* addresses
— the list's contents, its size, and whether it exists at all.

The page replaces `@auth/core`'s built-in error card, which offered a "Sign
in" button underneath "You do not have permission to sign in" — the identical
journey, refused identically.

**`/auth/error` must never be put behind an auth gate, and nothing will stop
you.** `@auth/core` never fetches the page and cannot tell whether it is
gated. Its only related check compares the current request's `callbackUrl`
query parameter against `pages.error` (`index.js:93-96`), and only on the
config-error branch — it catches one specific `?callbackUrl=/auth/error`
loop, not a gated page. Gate this page and a refused visitor loops: 302 to
`/auth/error`, the gate redirects them to sign in, the sign-in is refused,
302 to `/auth/error`, forever. Calling `auth()` is not itself the hazard —
`AppShell` → `AuthStatus` already does, on every page — redirecting on its
result is.

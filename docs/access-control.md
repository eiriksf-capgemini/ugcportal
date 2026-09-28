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
3. **There is exactly one place that decides.**
   `decideSignIn` in [`src/lib/sign-in-policy.ts`](../src/lib/sign-in-policy.ts),
   reached through the `isPermittedSignIn` wrapper from the `signIn` callback
   in [`src/lib/auth.ts`](../src/lib/auth.ts). No other module may form its own
   opinion about who is allowed in. Gates *downstream* of sign-in (admin role,
   row ownership, rights clearance) are separate questions and stay where they
   are.
4. **Refusal happens at sign-in, not at each surface.** A refused identity
   never gets a `User`, `Account` or `Session` row — `@auth/core` throws
   `AccessDenied` before `handleLoginOrRegister` runs — so `auth()` returns
   null and every existing gate answers 401 or redirects without knowing this
   rule exists. A new surface that gates on `session.user.id` is therefore
   already covered, and that is the point of putting the decision here.

   The cost of deciding it once, at the door, is that it is also decided
   *only* at the door: a session minted before the rule changed keeps working
   until it expires. See "Deploying this does not evict anyone already signed
   in" below, and `ugcportal-mzr`.

## What is provisional

**The rule itself.** Today it is a configured allowlist of exact email
addresses (`ALLOWED_SIGNIN_EMAILS`, unioned with `ADMIN_BOOTSTRAP_EMAILS`).

Whether the right rule is an allowlist, an invite system, a domain match, or
manual approval of each request is a **product decision that has not been
made**. The allowlist is the smallest mechanism that is correct under all four
answers, chosen so that the default could be fixed immediately without
pre-empting the choice.

**The seam to replace:** `permittedIdentities` and `decideSignIn` in
`src/lib/sign-in-policy.ts`. Swapping the mechanism means rewriting those two
functions — plus widening `decideSignIn`'s input if the new rule needs more
than an email address, and making it async if it needs a database. Everything
else, including the closed-by-default property and every downstream gate,
stays as it is.

Deliberately **not** implemented, because each would silently be the decision:

- a wildcard or domain pattern (`*@example.com` is rejected, and named in the
  log, rather than read as "anyone at this domain");
- an "allow all authenticated" escape hatch or `ALLOW_ANY_SIGNIN=true`;
- self-service sign-up with later approval.

## What an operator has to do

| Variable | Effect |
| --- | --- |
| `ALLOWED_SIGNIN_EMAILS` | Comma-separated exact addresses permitted to sign in. **This is the one that decides who can upload.** |
| `ADMIN_BOOTSTRAP_EMAILS` | First-admin bootstrap (`ugcportal-lu7`). Also grants sign-in — see below. |

Neither set: nobody can sign in, and the server says so loudly at startup
(`checkSignInConfiguration` in `src/instrumentation.ts`). See `env.example`
for the full notes.

### Deploying this does not evict anyone already signed in

**Setting `ALLOWED_SIGNIN_EMAILS` is not the whole deployment step.** The gate
runs at sign-in, and nothing here revokes a session that already exists.

`session: { strategy: "database" }` with no `maxAge` override means
`@auth/core`'s default: **30 days** of idle life per session
(`node_modules/@auth/core/lib/init.js:38`), stored in the `Session` table. An
account that signed in while `defaultCallbacks.signIn` was permitting
everybody keeps a valid cookie, `auth()` still resolves it out of that table,
and `POST /api/media` still sees a `session.user.id` and still lets them
upload and publish — for up to 30 days after this fix ships.

So, on the deploy that first carries this:

1. **Revoke every session.** This is the part that is always correct, and it
   is enough to make the gate effective: everyone signs in again and the new
   callback decides.

   ```bash
   npx prisma db execute --url "$DATABASE_URL" --stdin <<'SQL'
   DELETE FROM Session;
   SQL
   ```

2. **Then decide, per account, whether it should exist at all.** List them
   first — this is also how you check the allowlist you just wrote covers the
   people you meant:

   ```bash
   npx prisma db execute --url "$DATABASE_URL" --stdin <<'SQL'
   SELECT u.email, u.role, COUNT(m.id) AS uploads FROM User u
   LEFT JOIN Media m ON m.userId = u.id GROUP BY u.id ORDER BY u.email;
   SQL
   ```

   **Do not reflexively delete the `User` rows.** `Account`, `Session`,
   `Media` and (through `Media`) `MediaListing` all declare
   `onDelete: Cascade`, so deleting a user silently destroys their upload
   records — while leaving the actual objects in the bucket, originals and
   watermarked previews both, with nothing left referencing them. Leaving an
   unwanted account in place with no session and no way to sign in is the
   safer default; it can reach nothing.

Today this is very likely a no-op — nothing has been deployed (`ugcportal-321`)
— but it is written here because the doc is what the next operator reads, and
"the gate is live" and "nobody unwanted holds a session" are two different
facts.

Doing any of this **in code** — purging sessions on boot, re-checking the
policy per request, or shortening `maxAge` — is deliberately *not* in the PR
that added the gate. See `ugcportal-mzr`, filed for it.

## How the email is compared

Small things, each of which has been a real bug somewhere:

- entries are split on commas, trimmed and lowercased; blank entries are
  dropped;
- an entry that is not shaped like an email address is **ignored and named**,
  at startup and on every refusal. It does not permit anybody, and it does not
  silently disappear either. Silently permitting nobody and silently
  permitting everybody are both bad, and the reporting is what keeps the first
  one from being the second one's twin;
- `user.email` is optional on the Auth.js user object, so it is normalised to
  `null` when absent or empty and an absent address cannot match anything;
- the address compared is the one the adapter will persist and every
  downstream gate will see — but it is only trusted once the provider's own
  profile agrees with it. A profile asserting `email_verified: false`, or
  naming a different address than the one being authorised, is refused rather
  than reconciled. Authorising address A while admitting address B is the
  "compares the wrong two things" family, and it is the one that matters most
  here.

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

**A refusal is not a 403, and nothing should monitor or assert one.** Setting
`pages.error` is precisely what gives that status up: `@auth/core` serves its
built-in card with `toResponse(renderPage().error(...))` at HTTP 403, but with
`pages.error` set it takes the other branch of the same catch block
(`node_modules/@auth/core/index.js:135-141`) and returns `Response.redirect()`
— a 302, whose default status is unmodified. The user-visible outcome is
better and the trade is deliberate, but a monitor keyed on "403 means
refused" would report a wide-open instance as healthy.

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
journey, refused identically. It must stay reachable without authentication;
`@auth/core` detects a `pages.error` that requires auth and abandons it.

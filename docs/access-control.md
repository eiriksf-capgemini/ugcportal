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
2. **The permitted set comes from configuration, never from a rule the code
   invents.** No domain literal, no "if the database is empty" branch, no
   wildcard. Since `ugcportal-t33p` part of that configuration is a committed
   TypeScript module (`src/config/users.ts`) rather than an environment
   variable, and the distinction being kept is the one that matters: those are
   still *addresses an operator wrote down*, reviewed in a diff, not a
   predicate the code evaluates. The repository is private, the list changes
   when a person is added, and committing it is what lets the compiler check
   the provider half and lets one commit mean one answer on every deployment.
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
addresses (`ALLOWED_SIGNIN_EMAILS`, unioned with `ADMIN_BOOTSTRAP_EMAILS` and
with every identity in `src/config/users.ts`).

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

| Source | Effect |
| --- | --- |
| [`src/config/users.ts`](../src/config/users.ts) | The people this instance is for, each with the identities that belong to them. **Every identity listed here may sign in, and all of one person's identities share one user.** The usual place to add somebody (`ugcportal-t33p`). |
| `ALLOWED_SIGNIN_EMAILS` | Comma-separated exact addresses permitted to sign in, each optionally bound to one provider with a `google:` or `facebook:` prefix. For somebody who is not (yet) a person in the array — a colleague who only needs to upload. |
| `ADMIN_BOOTSTRAP_EMAILS` | First-admin bootstrap (`ugcportal-lu7`). Also grants sign-in — see below. |

All three are **unioned into one permitted set**. Nothing set anywhere, and
the array empty: nobody can sign in, and the server says so loudly at startup
(`checkSignInConfiguration` in `src/instrumentation.ts`). See `env.example`
for the full notes on the two variables.

### One person, several sign-in identities

Auth.js links an OAuth account by the provider's stable subject and otherwise
falls back to the e-mail address, so one person arriving through Google with
one address and through Facebook with another used to become **two users** —
two upload histories, two role rows, two of everything that hangs off
`User.id`. `src/config/users.ts` is the answer:

```ts
export const CONFIGURED_USERS: readonly ConfiguredUser[] = [
  {
    name: "Eirik",
    identities: [
      "google:eiriksanderfjeld@gmail.com",
      "facebook:eirik@sander-fjeld.com",
    ],
  },
  // ...
];
```

The identity syntax is the same `provider:address` form
`ALLOWED_SIGNIN_EMAILS` accepts (`ugcportal-1551`), and the provider half is
checked **by the compiler** — `twitter:` or a typo'd `gogle:` does not build.
There is no unbound form: an identity here always names exactly one provider.

**Where the linking happens, and why it is after the gate.** @auth/core's
OAuth callback runs `callbacks.signIn` — the gate — and only then asks the
adapter to find or create the user. `src/lib/configured-user-link.ts` wraps
three adapter methods — `getUserByEmail`, `createUser` and `linkAccount` —
so that for an identity in the array:

* the user is **never** resolved by e-mail address;
* the user **is** resolved by a stable handle derived from `name`
  (`eirik`), stored in `User.configuredHandle`, created on the person's first
  sign-in and found by every later one; and
* an `Account` row is only ever attached to that person's own user.

The pair it matches on comes from the AsyncLocalStorage slot that
`callbacks.signIn` fills *after* it has permitted the identity — the same
mechanism that records which identity minted a session (`ugcportal-mzr`). So
there is no path on which linking happens for an identity the gate refused,
and nothing the gate itself calls writes a row. An identity that is not in
the array goes through the unwrapped adapter, unchanged: no handle, one user
per identity, and @auth/core's own `OAuthAccountNotLinked` protection exactly
where it was.

The lookup is on the **exact** (provider, normalised address) pair. Never the
domain, never the provider alone, never the address alone. Two people who
happen to share an e-mail domain, or a provider, are two people.

**What the array does not do:** it grants no role (that is still
`ADMIN_BOOTSTRAP_EMAILS` and the admin screen), and it displays nothing
publicly (`ugcportal-137`). `User.name` is set from it when the row is
created and is not rewritten afterwards.

**Revocation stays per identity, by design** (`ugcportal-mzr`): removing one
of a person's identities refuses and deletes only the sessions that identity
minted, because each session is judged on the `signInProvider` /`signInEmail`
recorded on its own row — their other identity keeps working, on its own
devices, until it too is removed. Sharing a `User` row changed who owns the
uploads; it deliberately did not make revocation an action against a person.

**A sign-in made while somebody else's session is open is refused**, not
linked. Auth.js's already-signed-in branch attaches the new account to
whoever holds the session cookie, with no reference to the identity actually
signing in. `linkAccount` is wrapped to refuse that, write nothing, and send
the visitor to the Access Denied page. **It refuses in both directions**:

* an identity **in the array**, arriving on top of anybody else's session —
  that person's account would land on the session-holder's row; and
* an identity **not** in the array (admitted by `ALLOWED_SIGNIN_EMAILS`),
  arriving on top of a **configured person's** session — the stranger's
  account would land on theirs, and `getUserByAccount` would resolve the
  stranger to that person from then on: their uploads, their role, their
  rights clearance.

The limit, stated rather than implied: two addresses that are *both* only in
`ALLOWED_SIGNIN_EMAILS` still behave exactly as Auth.js makes them behave,
because neither row belongs to a configured person. Changing that is a
decision about Auth.js's own default, not something this feature took.

Sign out first, then sign in.

#### Adding a person who already has an account

Add them to the array and restart. If they have **never** signed in, that is
the whole operation — their first sign-in creates the row with the handle
already on it.

If they have signed in before (through `ALLOWED_SIGNIN_EMAILS`, say), they
already own a user row with no handle, and possibly more than one. That row
has to be adopted, or their next sign-in creates a second, empty user beside
it — and **re-running the existing reconciliation migration will not do it**.
That migration carries a *snapshot* of the array as it stood when it was
written (SQL cannot read a TypeScript module), so re-applying it is a no-op
for anybody added since: it is idempotent precisely because it only ever acts
on the four identities named inside it.

So adopting a newly-added person is a **new migration**. The cheapest correct
one is a copy of `20261005120500_reconcile_configured_users` with its
`INSERT INTO "_ConfiguredIdentitySeed"` rows replaced by the new person's —
every other statement is generic over that table and needs no edit. Give it a
later timestamp, and check the handle you type against what
`configuredUserHandle` derives (the test in
`src/lib/configured-user-reconciliation-migration.test.ts` does this for
every migration that carries seed rows, so a typo fails CI rather than
adopting nobody).

For a single person who has only ever had one user, the whole of it is one
statement, and running it by hand is reasonable:

```bash
DB="${DATABASE_URL:-file:./dev.db}"
sqlite3 "${DB#file:}" \
  "UPDATE \"User\" SET \"configuredHandle\" = 'their-handle' WHERE \"email\" = 'the-address-they-signed-in-with';"
```

Either way, do it **before** their next sign-in. Afterwards they have two
rows and need the merge, not the stamp.

#### Renaming a person

**The `name` in the array is a key, not a label.** The handle is derived from
it, so changing `Eirik` to `Eirik S-F` changes the handle to `eirik-s-f`, and
the next sign-in finds no row with that handle and creates a second, empty
user — the exact split this feature removes. It cannot be detected at boot,
because the check that runs there has no database.

So a rename is two steps, in this order:

```bash
DB="${DATABASE_URL:-file:./dev.db}"
sqlite3 "${DB#file:}" \
  "UPDATE \"User\" SET \"configuredHandle\" = 'new-handle' WHERE \"configuredHandle\" = 'old-handle';"
# then edit src/config/users.ts and redeploy
```

`checkConfiguredUsers` in `src/instrumentation.ts` reports every mistake that
*is* visible without a database, each on its own line at startup, and
**removes whatever it names** — a reported identity or person is neither
permitted through the array nor linked, so there is no state in which the
boot log says one thing and the gate does another. The full list:

| What | What happens to it |
| --- | --- |
| An identity naming an unknown provider (`twitter:`, `gogle:`) | that identity is dropped |
| An identity whose address is not one exact address (`google:`, a wildcard, a doubled prefix) | that identity is dropped |
| One identity listed under two people | dropped from **both** — nothing can tell which of them meant it |
| One **address** listed under two people, at any providers | every identity carrying it is dropped: `User.email` is UNIQUE, so the second of them could never have a row |
| A person with no identities | that person is dropped |
| A person whose name yields no handle at all (no letters or digits) | that person is dropped |
| A person whose handle would silently drop a letter (`Łukasz` → `ukasz`) | that person is dropped |
| Two people whose names slug to the same handle | **both** are dropped — the handle is UNIQUE |

A dropped identity can still be admitted by `ALLOWED_SIGNIN_EMAILS`, where it
gets a user of its own and no handle, exactly as any other allowlisted address
does. Being dropped costs the linking, not the access.

One address at **both** providers for **one** person is not on this list and
never will be: that is one row, and the point of the array.

### The one-off reconciliation for people who already have two users

`prisma/migrations/20261005120500_reconcile_configured_users` is a data-only
migration. For each person in the array *as of the commit that added it*, it
finds every user matching one of their exact (provider, address) identities,
keeps the **oldest**, stamps it with the handle and the configured name, and
moves everything the others own onto it — `Account`, `Session`, `Media`,
`RoleChange` (both the target and the actor columns), `ResaleRightsEvent`, and
the remaining user foreign keys — before deleting them.

It is **idempotent**: after it has run, each person has one user and there is
nothing left to move, so applying it again writes the same values and changes
no row. A stray that still owns something which cannot be moved (a second
standing `ResaleRightsReview`, for instance, which is unique per user) is
**left in place rather than deleted**, because deleting it would destroy that
row through the cascade. Such a user is inert — its accounts have moved, so
nobody can sign in as it — and shows up here:

```bash
DB="${DATABASE_URL:-file:./dev.db}"
sqlite3 "${DB#file:}" \
  "SELECT u.id, u.email FROM \"User\" u
   WHERE u.\"configuredHandle\" IS NULL
     AND NOT EXISTS (SELECT 1 FROM \"Account\" a WHERE a.\"userId\" = u.\"id\");"
```

Its copy of the array is a **snapshot**, not a reference — SQL cannot read a
TypeScript module. Adding a person later does not mean editing this migration;
it means a new one, if they already had an account (see "Adding a person who
already has an account" above). A test
(`src/lib/configured-user-reconciliation-migration.test.ts`) checks the one
thing that could drift silently: that each handle in the SQL is what
`configuredUserHandle` derives from that name, and each identity is what the
policy's own parser parses.

A migration rather than a script under `scripts/`, because this repository has
no way to *run* a TypeScript script — the generated Prisma client is
TypeScript, every module imports through the `@/*` path alias, and nothing in
`devDependencies` resolves either from Node. A migration is the mechanism
already used twice here for moving data, and it comes with a test convention
that a hand-run script does not.

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
- A refusal that is a **decision about this identity** (`not-permitted`,
  `wrong-provider`, `no-email`) also **deletes that session's row**, so the
  cookie is dead rather than merely useless. `no-email` belongs with the
  other two even though it sounds like a mishap: it means the session has no
  recorded address and the user row has none either, so there is nothing to
  judge, nothing outside the row that can supply one, and the same identity
  cannot sign in again either.
- A refusal that means *the policy cannot be evaluated* — no configuration
  at all — refuses the request just as hard but **leaves the row alone**.
  That distinction is deliberate: losing the environment variables is an
  outage, not a revocation, and restoring them should restore the sessions
  rather than having silently logged everyone out of every device while
  nobody could sign in to notice.
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
4. **Keep the logs if you want a record of it.** Revocation is silent by
   design on the visitor's side, and the `[auth] Refused a live session for
   user <id>` warning (plus the `Revoked session <id>` line beside it) is now
   the **only** trace that a particular session ever existed — the row it
   describes is deleted in the same breath, and `ugcportal-mzr` replaced the
   old "look first, then revoke" ordering with something that needs no
   operator at all. If who held a session matters to you — an incident, a
   question about what an account reached — ship the server's stdout
   somewhere durable before you need it, because afterwards there is nothing
   left to query. The lines name a user id, never an address.

### Deploy order: migrate first, then deploy

**Run `prisma migrate deploy` before rolling out the code that reads the new
columns.** The generated Prisma client selects every scalar column the schema
knows about, so a new client against a database that has not had
`20261004180000_add_session_sign_in_identity` applied fails
`getSessionAndUser` — which is every `auth()` call, for everybody, including
the operator, on every page. The migration itself is additive (two nullable
columns and a backfill) and is harmless to the running old code, which simply
never selects them.

The same applies to `20261005120000_add_user_configured_handle`
(`ugcportal-t33p`), one nullable column on `User` with a UNIQUE index, and to
`20261005120500_reconcile_configured_users`, which only moves rows. Both are
harmless to the old code, and the new code cannot read `User` at all until the
first has run.

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
(`RoleChange.actorEmail`), and the uploader label on the rights screen. So an
audit trail may name an address its owner no longer uses.

It is **no longer** what the first-admin bootstrap matches. Since
`ugcportal-t33p`, `reconcileBootstrapAdmin` judges the address *this* sign-in
was permitted under — the one the gate put in the request's identity slot —
falling back to `User.email` only outside a sign-in. So a bootstrap entry
names the address you will actually arrive with, and a stale stored address
does not silently stop the promotion.

## How this composes with the first-admin bootstrap

`ADMIN_BOOTSTRAP_EMAILS`, `ALLOWED_SIGNIN_EMAILS` and the identities in
`src/config/users.ts` are **unioned into one permitted set**. Consequences,
both intended:

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

**One thing that changed with `ugcportal-t33p`, and it is a simplification.**
Once a person can hold two identities on one row, `User.email` is whichever
of them signed in first — so matching the promotion against it would have
meant bootstrapping somebody under one address and watching nothing happen.
`reconcileBootstrapAdmin` therefore judges **the address this sign-in was
permitted under**, taken from the identity slot the gate fills, and falls back
to the stored address only when there is no sign-in in scope.

So: **name the identity they will arrive with**. A provider-bound entry
(`google:someone@example.com`) promotes on a Google sign-in by that address
whatever `User.email` happens to say, and there is no reason to list both of
a person's addresses. Nothing else about the bootstrap changed: it still
promotes only a listed address with no role history, only through the provider
a bound entry names, and it still runs as an event after the gate.

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

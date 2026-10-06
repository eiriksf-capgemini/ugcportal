import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, {
  type DefaultSession,
  type NextAuthConfig,
} from "next-auth";
import { cache } from "react";

import type { Role } from "@/generated/prisma/enums";
import { reconcileBootstrapAdmin } from "@/lib/admin-bootstrap";
import { withConfiguredUserLinking } from "@/lib/configured-user-link";
import {
  enforceLiveSessionPolicy,
  rememberSignInIdentity,
  withSessionIdentity,
  withSignInIdentity,
} from "@/lib/live-session";
import { prisma } from "@/lib/prisma";
import { AUTH_ERROR_PATH } from "@/lib/routes";
import { withSchemaMismatchLogging } from "@/lib/schema-mismatch";
import { isPermittedSignIn } from "@/lib/sign-in-policy";
import { signInProviders } from "@/lib/sign-in-providers";

declare module "next-auth" {
  interface Session {
    /**
     * OPTIONAL, and that is load-bearing (PR #91 review, round 2, finding
     * 2). Since ugcportal-mzr the `session` callback below can answer with
     * a session that has no user on it — that is how a revoked identity is
     * refused — so `auth()` really does resolve `{ expires }` with no
     * `user` for a revoked visitor. Declaring it required would let a
     * future `session.user.id` compile and then throw at runtime on
     * exactly that path, which is the one nobody exercises by hand. Every
     * caller today already asks `session?.user?.id` or `hasSignedInUser`
     * (src/lib/session.ts); this makes the compiler keep it that way.
     */
    user?: {
      id: string;
      role: Role;
    } & DefaultSession["user"];
  }
}

// The Prisma adapter hands back the whole `User` row, `role` included, but
// `AdapterUser` doesn't declare it — and that type comes from a transitive
// `@auth/core` package, so widening it here is more brittle than reading
// the field defensively. Anything that isn't literally "ADMIN" becomes a
// plain user, so a missing or unexpected value fails closed rather than
// granting access (see requireAdmin in src/lib/admin.ts).
function toRole(user: object): Role {
  return (user as { role?: unknown }).role === "ADMIN" ? "ADMIN" : "USER";
}

// AUTH_URL / NEXTAUTH_URL should point at http://localhost:3000 for local
// dev (see env.example) so the Google/Facebook callbacks match the redirect
// URIs registered in each provider's console. Production redirect URIs
// are tracked separately in ugcportal-5jd.
/**
 * Exported so the sign-in gate can be tested as wired, not merely as
 * written. A unit test of src/lib/sign-in-policy.ts passes whether or not
 * anything calls it; src/lib/auth.test.ts drives
 * `authConfig.callbacks.signIn` so that deleting the callback — the exact
 * shape of the ugcportal-egp defect — fails a test.
 */
export const authConfig = {
  // The Prisma adapter, plus the two things @auth/core's adapter interface
  // has no room for, both of which need the identity the `signIn` callback
  // below has in hand and the adapter does not:
  //
  //   `withSessionIdentity` (ugcportal-mzr) writes WHICH IDENTITY MINTED
  //   this session into the same INSERT that creates it, which is what
  //   removes the race a later lookup had (PR #91 review, round 2,
  //   finding 1).
  //
  //   `withConfiguredUserLinking` (ugcportal-t33p) resolves a configured
  //   person's `User` row by their handle instead of by e-mail, so Eirik's
  //   Google and Facebook accounts land on one user with one upload history
  //   instead of two. See that module for exactly where in @auth/core's
  //   flow this happens and why it is necessarily after the gate.
  //
  // Order is not significant: the two wrappers override disjoint methods
  // (`createSession` versus `createUser`/`getUserByEmail`) and neither reads
  // the other's. Linking is outermost only because it is the newer layer.
  //
  // `withSchemaMismatchLogging` (ugcportal-w7wc) is outermost BECAUSE order
  // matters for it: it reports and rethrows, so wrapping the other two is
  // what lets it see an error raised anywhere underneath. Without it a
  // database behind prisma/migrations shows up only as @auth/core's generic
  // `SessionTokenError`, on a page that still answers 200.
  adapter: withSchemaMismatchLogging(
    withConfiguredUserLinking(withSessionIdentity(PrismaAdapter(prisma))),
  ),
  session: { strategy: "database" },
  // A first-party Access Denied screen (src/app/auth/error/page.tsx). Without
  // this, a refused sign-in lands on @auth/core's built-in page, which says
  // "You do not have permission to sign in" above a Sign in button that
  // starts the same refused journey over again. This one explains that the
  // instance is private and stops offering the loop, with the same words for
  // every refusal — the reason is only ever logged server-side.
  //
  // MIND THE STATUS CODES, because setting this is what changes them. Both
  // of @auth/core's error paths render their built-in card with
  // `toResponse(renderPage().error(...))`, which carries a real status; with
  // `pages.error` set, both instead return `Response.redirect()` — a 302 to
  // this app's own page, which answers an ordinary 200.
  //
  //   refused sign-in   403 -> 302 then 200   (catch block, index.js:135-141)
  //   broken auth config 500 -> 302 then 200  (index.js:97-106)
  //
  // The second is the one worth losing sleep over: a deployment missing
  // AUTH_SECRET, where NOBODY can sign in, now answers an uptime check as
  // healthy. Nothing should monitor or assert either status as a signal
  // about this app. (The config branch only rewrites HTML GETs to the auth
  // pages; a non-GET or a non-page action such as /api/auth/session still
  // answers JSON 500 at index.js:86-88, so that is the one an uptime check
  // can still key on.) PR #45 review, rounds 1 and 3.
  pages: { error: AUTH_ERROR_PATH },
  callbacks: {
    /**
     * The authorisation gate (ugcportal-egp). Closed by default, opened by
     * configuration: `isPermittedSignIn` refuses unless the address appears
     * in ALLOWED_SIGNIN_EMAILS or ADMIN_BOOTSTRAP_EMAILS — and, for an entry
     * bound to a provider (ugcportal-1551), arrives through that provider.
     *
     * Returning `false` matters more than it looks. Auth.js turns it into an
     * `AccessDenied` before `handleLoginOrRegister` runs, so a refused
     * identity gets no User row, no Account row and no Session row — which
     * is why `auth()` later returns null for them and every downstream gate
     * answers 401 without knowing this rule exists.
     *
     * The defect this replaces was the ABSENCE of this callback, not a wrong
     * answer from it: @auth/core's `defaultCallbacks.signIn` (lib/init.js)
     * returns `true`, so with Google and Facebook configured, every account
     * on the internet was permitted. `handleAuthorized` refuses on any falsy
     * answer, so the risk is not an accidental `undefined` — it is answering
     * with a truthy non-boolean. A string, in particular, is read as a
     * redirect URL rather than as permission.
     */
    signIn({ user, account, profile }) {
      // `account` carries the provider id, which a bound allowlist entry
      // (`google:addr`, ugcportal-1551) is judged against.
      const attempt = { user, account, profile };
      if (!isPermittedSignIn(attempt)) {
        return false;
      }
      // Permitted — so remember what this sign-in asserted, for the session
      // row @auth/core is about to create for it (ugcportal-mzr). Nothing is
      // written here: the identity rides the request in an AsyncLocalStorage
      // slot and lands in that row's own INSERT, which is the only way to
      // attribute it without guessing which row belongs to which of two
      // concurrent sign-ins (PR #91 review, round 2, finding 1).
      //
      // After the gate, never before it: a refused attempt creates no
      // session, and the slot must not describe one that does not exist.
      //
      // SINCE ugcportal-t33p THE SLOT HAS A SECOND READER: the adapter
      // wrapper that attaches this sign-in's Account row to the configured
      // person's one User row. This line is therefore the single point at
      // which both the session attribution and the identity linking become
      // possible, and it is downstream of the refusal above — which is what
      // makes "linking happens only for an identity the gate permitted" a
      // property of the control flow rather than of a second check.
      rememberSignInIdentity(attempt);
      return true;
    },
    // Database session strategy hands us the adapter user record here;
    // surface its id so route handlers can associate uploads (ugcportal-8wa)
    // and other user-owned records without a second lookup.
    //
    // THE SECOND GATE (ugcportal-mzr). The `signIn` callback above runs once,
    // at the door; this one runs on every request, and asking the policy
    // again here is what makes removing an address from ALLOWED_SIGNIN_EMAILS
    // revoke the session that address is already holding, instead of only its
    // next sign-in up to 30 days later. The enforcement — including why a
    // refusal cannot simply `delete session.user`, and what it costs — lives
    // in src/lib/live-session.ts; this callback stays the wiring.
    //
    // The two assignments below are left in front of it deliberately: they
    // are what a PERMITTED session needs, and a refused one discards the
    // whole `user` object anyway, so neither value can reach a caller whose
    // session was refused.
    async session({ session, user }) {
      // Rebuilt rather than mutated in place, because `Session["user"]` is
      // now optional (see the augmentation above) — and the spread keeps
      // every field @auth/core had already put there.
      session.user = {
        ...session.user,
        id: user.id,
        // Read on every request under the database session strategy, so
        // revoking someone's admin role takes effect immediately instead of
        // waiting for their session to expire.
        role: toRole(user),
      };
      // `session` carries the row's own columns at runtime, the recorded
      // sign-in identity among them; `user` is only needed for the id in
      // the log line and the pre-column address fallback.
      return enforceLiveSessionPolicy(session, {
        id: user.id,
        email: user.email,
      });
    },
  },
  events: {
    // The first-admin bootstrap (ugcportal-lu7). Runs here rather than in the
    // session callback because that one fires on every request and this needs
    // a write; sign-in is the one moment where doing it once is both cheap
    // and early enough for the same visit to land on an admin page.
    //
    // An event, so it only fires for sign-ins the callback above already
    // permitted — and it could not admit anyone it refused in any case,
    // because ALLOWED_SIGNIN_EMAILS and ADMIN_BOOTSTRAP_EMAILS are unioned
    // into one permitted set (see permittedIdentities). Being listed for
    // bootstrap is therefore itself a grant of sign-in, not a way around
    // one. It does not promote on an empty database; it promotes a listed
    // address with no role history — and, for a provider-bound entry, only
    // when the sign-in came through that provider (PR #81 round 5), which is
    // why `account` is handed on.
    async signIn({ user, account }) {
      await reconcileBootstrapAdmin(user, account);
    },
  },
  // Built from SIGN_IN_PROVIDERS in src/lib/sign-in-providers.ts, so the
  // providers configured here and the prefixes the allowlist accepts are one
  // list (ugcportal-1551).
  providers: signInProviders,
} satisfies NextAuthConfig;

const nextAuth = NextAuth(authConfig);

export const { auth, signIn, signOut } = nextAuth;

/**
 * The Auth.js route handlers, each wrapped so the request it serves has its
 * own slot for the identity a sign-in asserts (ugcportal-mzr).
 *
 * The wrapper has to be here rather than in
 * src/app/api/auth/[...nextauth]/route.ts because this is where the adapter
 * that reads the slot is configured: the two halves are one mechanism, and
 * splitting them across files is how one of them gets moved later without
 * the other. Every sign-in reaches the database through these handlers —
 * the OAuth callback and the `signIn()` helper alike both POST through
 * them — so a session created outside one of them is a session no sign-in
 * asked for.
 */
export const handlers = withSignInIdentity(nextAuth.handlers);

/**
 * `auth()`, memoized for the lifetime of one React render (ugcportal-t0y
 * round 1 medium finding).
 *
 * Only for use from inside a React Server Component render — React's
 * `cache()` dedupes calls made during the same render pass; called from
 * outside one (a route handler, a server action) it has no render to key
 * its memoization against, so it transparently falls through to an
 * ordinary, uncached call, identical to calling `auth()` directly. Safe
 * either way, just not cheaper outside a render.
 *
 * Within a render, src/components/upload-nav-link.tsx, src/components/
 * auth-status.tsx and (via `requireAdmin` in src/lib/admin.ts) the three
 * admin/settings/{users,rights,instagram}/page.tsx pages all call this
 * independently — none awaits another's result first — so they render
 * concurrently with whatever else the page is fetching (see the comment on
 * AppShell in src/components/app-shell.tsx for why a *parent* awaiting the
 * session before returning its children would undo that), and this app's
 * `"database"` session strategy means every one of those calls shares a
 * single adapter round trip instead of paying for its own.
 *
 * Universal as of ugcportal-asg (CLOSED): src/app/upload/page.tsx now calls
 * this same getSession() (src/app/upload/page.tsx, "const session = await
 * getSession()"; fixture proof in page.test.tsx, whose vi.mock exports only
 * getSession, no auth key — an unmigrated auth() call would throw against
 * it), so a signed-in visit to /upload shares the one adapter round trip
 * above rather than paying for a second.
 */
export const getSession = cache(() => auth());

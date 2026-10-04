import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, {
  type DefaultSession,
  type NextAuthConfig,
} from "next-auth";
import Facebook from "next-auth/providers/facebook";
import Google from "next-auth/providers/google";
import { cache } from "react";

import type { Role } from "@/generated/prisma/enums";
import { reconcileBootstrapAdmin } from "@/lib/admin-bootstrap";
import { prisma } from "@/lib/prisma";
import { AUTH_ERROR_PATH } from "@/lib/routes";
import { isPermittedSignIn } from "@/lib/sign-in-policy";

declare module "next-auth" {
  interface Session {
    user: {
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
  adapter: PrismaAdapter(prisma),
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
      return isPermittedSignIn({ user, account, profile });
    },
    // Database session strategy hands us the adapter user record here;
    // surface its id so route handlers can associate uploads (ugcportal-8wa)
    // and other user-owned records without a second lookup.
    session({ session, user }) {
      session.user.id = user.id;
      // Read on every request under the database session strategy, so
      // revoking someone's admin role takes effect immediately instead of
      // waiting for their session to expire.
      session.user.role = toRole(user);
      return session;
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
    // address with no role history.
    async signIn({ user }) {
      await reconcileBootstrapAdmin(user);
    },
  },
  providers: [
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
    Facebook({
      clientId: process.env.AUTH_FACEBOOK_ID,
      clientSecret: process.env.AUTH_FACEBOOK_SECRET,
    }),
  ],
} satisfies NextAuthConfig;

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

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
 * Not yet universal: src/app/upload/page.tsx:24 still calls plain `auth()`
 * (ugcportal-t0y round 2 finding) — migrating it needs coordinating with the
 * concurrently open PR #46, which also touches that file, so it stayed
 * out of scope here and is filed separately as ugcportal-asg. A signed-in
 * visit to /upload therefore still costs two session queries, not one,
 * until that bead lands.
 */
export const getSession = cache(() => auth());

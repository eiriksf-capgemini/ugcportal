import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, {
  type DefaultSession,
  type NextAuthConfig,
} from "next-auth";
import Facebook from "next-auth/providers/facebook";
import Google from "next-auth/providers/google";

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
  // starts the same refused journey over again. Same HTTP 403 either way and
  // the same words for every refusal — the reason is only ever logged
  // server-side — but this one explains that the instance is private and
  // stops offering the loop.
  pages: { error: AUTH_ERROR_PATH },
  callbacks: {
    /**
     * The authorisation gate (ugcportal-egp). Closed by default, opened by
     * configuration: `isPermittedSignIn` refuses unless the address appears
     * in ALLOWED_SIGNIN_EMAILS or ADMIN_BOOTSTRAP_EMAILS.
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
    signIn({ user, profile }) {
      return isPermittedSignIn({ user, profile });
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

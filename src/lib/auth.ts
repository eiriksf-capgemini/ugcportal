import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth, { type DefaultSession } from "next-auth";
import Facebook from "next-auth/providers/facebook";
import Google from "next-auth/providers/google";

import type { Role } from "@/generated/prisma/enums";
import { reconcileBootstrapAdmin } from "@/lib/admin-bootstrap";
import { prisma } from "@/lib/prisma";

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
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  callbacks: {
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
});

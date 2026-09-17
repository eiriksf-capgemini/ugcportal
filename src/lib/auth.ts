import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import Facebook from "next-auth/providers/facebook";

import { prisma } from "@/lib/prisma";

// AUTH_URL / NEXTAUTH_URL should point at http://localhost:3000 for local
// dev (see env.example) so the Facebook callback matches the redirect URI
// registered in the Facebook app. Production redirect URIs are tracked
// separately in ugcportal-5jd.
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
  providers: [
    Facebook({
      clientId: process.env.AUTH_FACEBOOK_ID,
      clientSecret: process.env.AUTH_FACEBOOK_SECRET,
    }),
  ],
});

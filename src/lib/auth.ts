import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import Facebook from "next-auth/providers/facebook";
import Google from "next-auth/providers/google";

import { prisma } from "@/lib/prisma";

// AUTH_URL / NEXTAUTH_URL should point at http://localhost:3000 for local
// dev (see env.example) so the Google/Facebook callbacks match the redirect
// URIs registered in each provider's console. Production redirect URIs
// are tracked separately in ugcportal-5jd.
export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "database" },
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

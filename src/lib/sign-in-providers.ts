import Facebook from "next-auth/providers/facebook";
import Google from "next-auth/providers/google";
import type { Provider } from "next-auth/providers";

import { SIGN_IN_PROVIDERS, type SignInProvider } from "@/lib/sign-in-policy";

/**
 * The configured OAuth providers, built FROM the id list the allowlist parser
 * accepts, so the two cannot drift (PR #81 round 3): `satisfies` rejects a
 * factory map with a key missing from SIGN_IN_PROVIDERS or one it does not
 * list. Kept out of src/lib/sign-in-policy.ts on purpose — that module is
 * imported by src/instrumentation.ts in the Edge bundle and must stay free of
 * provider modules and the Prisma client; and out of src/lib/auth.ts so the
 * list that drives the gate is visibly the list that drives the config.
 *
 * What this does not prove is that the Auth.js id each factory reports is the
 * key it was built from — `Google()` yielding `"google"` is a library
 * convention, not a type. src/lib/auth.test.ts pins that.
 */
const factories = {
  google: () =>
    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  facebook: () =>
    Facebook({
      clientId: process.env.AUTH_FACEBOOK_ID,
      clientSecret: process.env.AUTH_FACEBOOK_SECRET,
    }),
} satisfies Record<SignInProvider, () => Provider>;

// Deliberately NOT annotated as `Provider[]`: the inferred element type is the
// union of the concrete OAuth configs, which keeps `.id` reachable for the
// pinning test in src/lib/auth.test.ts. `Provider` also admits the function
// form, on which `.id` does not exist.
export const signInProviders = SIGN_IN_PROVIDERS.map((id) => factories[id]());

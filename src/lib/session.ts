import type { Session } from "next-auth";

/**
 * The one definition of "signed in" the header uses (ugcportal-t0y round 3
 * finding).
 *
 * src/components/upload-nav-link.tsx and src/components/auth-status.tsx
 * each read the session independently (see the comment on `getSession` in
 * src/lib/auth.ts for why), and before this existed they each hand-spelled
 * their own gate — `session?.user?.id` in one, `session?.user` in the
 * other. For a session shaped like `{ user: { email } }` — a user object
 * with no id, the exact fixture src/app/upload/page.test.tsx's own K5 suite
 * already uses to prove the API-backing page's gate specifically requires
 * an id — the two disagreed: AuthStatus rendered "Sign out", while
 * UploadNavLink rendered nothing at all, so a visitor who looked signed in
 * had no in-app route to /upload. Latent in practice, because the
 * `session` callback in src/lib/auth.ts always sets `user.id` under the
 * `"database"` strategy — but nothing enforced that the two components
 * agreed if that ever changed.
 *
 * One predicate, imported by both, removes the possibility structurally:
 * the two components cannot spell "signed in" two different ways if
 * neither of them spells it out at all. Deliberately not exported from
 * src/lib/auth.ts itself, and importing nothing but a type from
 * "next-auth" — a pure predicate has no reason to pull in NextAuth's runtime
 * config (the adapter, the providers, cache()) just to ask a question about
 * a value it's already holding, and it means test files mocking
 * "@/lib/auth" (for `getSession`) don't also need to mock this: it's the
 * same real implementation on both sides.
 */
export function hasSignedInUser(
  session: Session | null,
): session is Session & { user: { id: string } } {
  return Boolean(session?.user?.id);
}

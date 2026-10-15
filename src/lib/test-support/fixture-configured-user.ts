import type * as UsersModule from "@/config/users";

/**
 * A fixture CONFIGURED person for tests that need one (ugcportal-lskg).
 *
 * Since ugcportal-lskg a `User` row is configured only while its
 * `configuredHandle` is one the CHECKED array derives TODAY
 * (`CURRENT_CONFIGURED_HANDLES`, src/lib/sign-in-policy.ts) — a non-null
 * column alone no longer counts. The ho7j suites seed a row with the fixture
 * handle `"fixture-handle"`, not a real person's, so they mock
 * `@/config/users` with this person appended to the real array:
 *
 *   vi.mock("@/config/users", async (importOriginal) => {
 *     const { withFixtureConfiguredUser } = await import(
 *       "@/lib/test-support/fixture-configured-user"
 *     );
 *     return withFixtureConfiguredUser(await importOriginal());
 *   });
 *
 * Appended rather than replacing, so the real people stay configured in the
 * same process and a test can still name one of them.
 */
export const FIXTURE_CONFIGURED_NAME = "Fixture Handle";

/** What `configuredUserHandle` derives from `FIXTURE_CONFIGURED_NAME`. */
export const FIXTURE_CONFIGURED_HANDLE = "fixture-handle";

/**
 * The fixture person's one identity. It has to exist: the list is built
 * from `reviewConfiguredUsers().sound`, which drops a person with no
 * identities. On a provider the policy accepts, at an
 * `example.com` address no real entry in src/config/users.ts uses
 * (src/lib/sign-in-policy.configured-handles.test.ts asserts it collides
 * with nothing there).
 */
export const FIXTURE_CONFIGURED_IDENTITY = "google:fixture-handle@example.com";

/**
 * A handle that is NOT derived from any name in the (mocked) array: the row
 * of a person removed from `CONFIGURED_USERS` after they signed in, whose
 * column nothing cleared (ugcportal-lskg K1).
 */
export const FORMER_CONFIGURED_HANDLE = "former-person";

export function withFixtureConfiguredUser(
  actual: typeof UsersModule,
): typeof UsersModule {
  return {
    ...actual,
    CONFIGURED_USERS: [
      ...actual.CONFIGURED_USERS,
      { name: FIXTURE_CONFIGURED_NAME, identities: [FIXTURE_CONFIGURED_IDENTITY] },
    ],
  };
}

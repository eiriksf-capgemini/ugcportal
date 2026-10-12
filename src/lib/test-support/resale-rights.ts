/**
 * Test-only fixture values for `ResaleRightsReview` (not imported by any
 * application code).
 *
 * DATA ONLY, no Prisma call, for the same reason
 * `src/lib/test-support/attestation.ts` is:
 * `src/lib/resale-rights-writers.test.ts`
 * asserts that exactly one non-test file writes a review row, and
 * a helper that called `create` on that model would be a second one. Note
 * that the scan there is over source TEXT, so even naming the call in a
 * comment here would fail it — callers pass the values below as part of
 * their own `data`, from their own test file, which the scan excludes.
 */

/**
 * A clearance cut-off that covers every upload a fixture creates
 * (ugcportal-aqw).
 *
 * `coversUploadsBefore` is the instant the reviewer signed: the gate sells
 * an upload only when `Media.createdAt` is strictly before it. Most
 * fixtures in this repo seed their `Media` with the default `createdAt`,
 * which is the moment the test runs — so a cut-off written as a real past
 * date would block them, and the test would be measuring this bead instead
 * of whatever it is about.
 *
 * Far-future rather than `coversFutureUploads: true`, which would ALSO make
 * them pass: that flag means "the signed instrument is a framework licence
 * over future works", a legal claim about a document, and a fixture that
 * asserted it would be saying something false about its own clearance.
 * A wide cut-off says only what is true — this clearance covers everything
 * that exists.
 *
 * A fixture that is actually ABOUT scope must not use this: see
 * `src/lib/clearance-scope-migration.test.ts` and the ugcportal-aqw blocks
 * in `src/lib/resale-rights.test.ts`, which set both columns deliberately.
 */
export const FIXTURE_CLEARANCE_SCOPE = {
  coversUploadsBefore: new Date("2099-01-01T00:00:00.000Z"),
  coversFutureUploads: false,
} as const;

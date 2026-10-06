import { afterEach, beforeEach } from "vitest";

/**
 * Test-only helper (not imported by any application code): state the
 * environment a test file runs under, and put the host's own back
 * afterwards.
 *
 * Extracted because the same twenty lines of save/set/restore had been
 * copied into five test files (PR #91 review, round 1, finding 6), each with
 * its own chance to get the restore wrong — and the failure mode of getting
 * it wrong is not a failing test here, it is an unrelated suite later in the
 * same process answering differently because this one left
 * `ALLOWED_SIGNIN_EMAILS` behind. That is the exact defect
 * src/lib/sign-in-policy.test.ts's header describes having shipped once
 * already, from the other direction: a gate reading the ambient environment
 * a caller believed it had overridden.
 *
 * Two files do not use pinEnvironment by design: src/lib/sign-in-policy.test.ts,
 * whose two process.env-default tests (see its header) set
 * ADMIN_BOOTSTRAP_EMAILS and ALLOWED_SIGNIN_EMAILS ambiently to assert the
 * ambient value is honoured; and src/lib/configured-user-link.test.ts, which
 * sets ALLOWED_SIGNIN_EMAILS at nine sites and deletes it in a finally block
 * each time.
 */

/**
 * Apply `values` before each test in this file, and restore whatever the
 * host had after each one.
 *
 * `undefined` as a value means "unset it", which is a different state from
 * the empty string: `ALLOWED_SIGNIN_EMAILS=` is configured-but-empty and
 * `ALLOWED_SIGNIN_EMAILS` absent is not configured at all, and this module
 * is the one place in the tests where those two must not be conflated.
 *
 * Call it at the top level of a test file, not inside a `describe` or an
 * `it`: the snapshot it restores to is taken when this function runs, so it
 * has to run before any test has had a chance to change anything.
 */
export function pinEnvironment(
  values: Readonly<Record<string, string | undefined>>,
): void {
  const names = Object.keys(values);
  // Captured once, at call time. Deliberately not re-read in `afterEach`:
  // that would restore to whatever the *previous* test left behind, which
  // is the bug this exists to prevent rather than a smaller version of it.
  const host = new Map(names.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    for (const name of names) {
      assign(name, values[name]);
    }
  });

  afterEach(() => {
    for (const name of names) {
      assign(name, host.get(name));
    }
  });
}

function assign(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

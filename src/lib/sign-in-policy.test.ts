import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PERMITTED_EMAILS_VAR,
  type SignInEnv,
  bootstrapAdminEmails,
  decideSignIn,
  isPermittedSignIn,
  permittedIdentities,
} from "@/lib/sign-in-policy";

/**
 * ugcportal-egp K1: who may sign in comes from configuration, and with no
 * configuration nobody may.
 *
 * Every test passes its own `env` object rather than mutating process.env, so
 * a developer or CI runner who happens to export ALLOWED_SIGNIN_EMAILS *or*
 * ADMIN_BOOTSTRAP_EMAILS cannot change an answer here. That claim was not
 * true when this file was first written — `permittedIdentities` honoured the
 * injected env for one variable and fell through to `process.env` for the
 * other — so "the injected env is the only source" now has its own test
 * below rather than being an assumption of the harness. The two tests that
 * exercise the process.env default say so and restore it.
 */

const LISTED = "owner@example.com";

function env(overrides: SignInEnv = {}): SignInEnv {
  return { [PERMITTED_EMAILS_VAR]: LISTED, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("permittedIdentities", () => {
  it("splits, trims, lowercases and de-duplicates", () => {
    expect(
      permittedIdentities({
        [PERMITTED_EMAILS_VAR]: " A@Example.com , b@example.com ,a@example.com",
      }).emails,
    ).toEqual(["a@example.com", "b@example.com"]);
  });

  it("is empty and reports itself unconfigured when unset or blank", () => {
    for (const raw of [undefined, "", " ", " , ,"]) {
      const identities = permittedIdentities({
        [PERMITTED_EMAILS_VAR]: raw,
      });
      expect(identities.emails).toEqual([]);
      expect(identities.malformed).toEqual([]);
      expect(identities.configured).toBe(false);
    }
  });

  it("refuses to read a wildcard as a domain rule", () => {
    // The mechanism Eirik has not chosen. `*@example.com` IS email-shaped, so
    // nothing but this explicit rejection keeps it from looking like it
    // worked — and a wildcard that worked would silently be the product
    // decision this bead is not allowed to make.
    const identities = permittedIdentities({
      [PERMITTED_EMAILS_VAR]: "*@example.com",
    });

    expect(identities.emails).toEqual([]);
    expect(identities.malformed).toEqual(["*@example.com"]);
    // Set-but-useless is a different state from unset, and the startup
    // warning tells them apart.
    expect(identities.configured).toBe(true);
  });

  it("names the entries it cannot use and keeps the ones it can", () => {
    const identities = permittedIdentities({
      // A bare username, a missing dot in the domain, a semicolon separator
      // (only commas split, so this is one entry), an address with a space.
      [PERMITTED_EMAILS_VAR]: `nobody, a@b, x@y.com;z@y.com, "a b"@c.com, ${LISTED}`,
    });

    expect(identities.emails).toEqual([LISTED]);
    expect(identities.malformed).toEqual([
      "nobody",
      "a@b",
      "x@y.com;z@y.com",
      '"a b"@c.com',
    ]);
  });

  it("unions in ADMIN_BOOTSTRAP_EMAILS, whatever the allowlist says", () => {
    // ugcportal-egp K3, as a property rather than an example: the bootstrap
    // cannot admit an identity sign-in would refuse, because being listed for
    // bootstrap IS a grant. If a future mechanism stops unioning this in, this
    // fails.
    const bootstrap = ["admin@example.com", "second@example.com"];
    for (const allowlist of [undefined, "", LISTED]) {
      const { emails } = permittedIdentities({
        [PERMITTED_EMAILS_VAR]: allowlist,
        ADMIN_BOOTSTRAP_EMAILS: bootstrap.join(","),
      });
      for (const email of bootstrap) {
        expect(emails).toContain(email);
      }
    }
  });

  it("is configured when only the bootstrap variable is set", () => {
    // A fresh deployment that followed env.example's bootstrap instructions
    // and nothing else must still be able to sign in, or this bead breaks
    // ugcportal-lu7.
    const identities = permittedIdentities({
      ADMIN_BOOTSTRAP_EMAILS: "admin@example.com",
    });

    expect(identities.configured).toBe(true);
    expect(identities.emails).toEqual(["admin@example.com"]);
  });

  it("reports an unusable bootstrap entry rather than letting it never match", () => {
    expect(
      permittedIdentities({ ADMIN_BOOTSTRAP_EMAILS: "admin" }).malformed,
    ).toEqual(["admin"]);
  });

  it("reads both variables out of the injected env and neither out of the ambient one", () => {
    // PR #45 round 1, medium 1. `bootstrapAdminEmails` has a default
    // parameter reading process.env, so `bootstrapAdminEmails(
    // env.ADMIN_BOOTSTRAP_EMAILS)` on an env object without that key passed
    // `undefined`, TRIGGERED the default, and unioned in addresses the caller
    // never mentioned. A gate granting from a source its caller believed it
    // had overridden.
    const AMBIENT = "ambient-leak@evil.example.com";
    const original = process.env.ADMIN_BOOTSTRAP_EMAILS;
    try {
      process.env.ADMIN_BOOTSTRAP_EMAILS = AMBIENT;

      // The needle is provably present at the source: the ambient value IS
      // readable through the default parameter, so the assertions below are
      // about permittedIdentities ignoring it, not about the value being
      // absent everywhere.
      expect(bootstrapAdminEmails()).toEqual([AMBIENT]);

      // An env object that mentions neither variable is UNCONFIGURED, even
      // though the ambient one names an address.
      const nothingInjected = permittedIdentities({});
      expect(nothingInjected.emails).toEqual([]);
      expect(nothingInjected.configured).toBe(false);

      // And one that mentions only the allowlist permits only the allowlist.
      expect(permittedIdentities(env()).emails).toEqual([LISTED]);

      // Right through the decision, which is where it would have mattered.
      expect(decideSignIn({ user: { email: AMBIENT } }, env())).toEqual({
        permitted: false,
        reason: "not-permitted",
      });
      expect(decideSignIn({ user: { email: AMBIENT } }, {})).toEqual({
        permitted: false,
        reason: "no-configuration",
      });
    } finally {
      if (original === undefined) {
        delete process.env.ADMIN_BOOTSTRAP_EMAILS;
      } else {
        process.env.ADMIN_BOOTSTRAP_EMAILS = original;
      }
    }
  });

  it("defaults to process.env", () => {
    const original = process.env[PERMITTED_EMAILS_VAR];
    try {
      process.env[PERMITTED_EMAILS_VAR] = "from-the-environment@example.com";
      expect(permittedIdentities().emails).toContain(
        "from-the-environment@example.com",
      );
    } finally {
      if (original === undefined) {
        delete process.env[PERMITTED_EMAILS_VAR];
      } else {
        process.env[PERMITTED_EMAILS_VAR] = original;
      }
    }
  });
});

describe("decideSignIn refuses by default (K1)", () => {
  it("refuses everyone when nothing is configured", () => {
    // THE DEFECT, stated as a test: with no configuration the answer is no.
    // The same identity is permitted two tests down, once configuration
    // names it — so this is not an assertion that always holds.
    expect(
      decideSignIn({ user: { email: LISTED } }, { NODE_ENV: "production" }),
    ).toEqual({ permitted: false, reason: "no-configuration" });
  });

  it("refuses an address that is not on the list", () => {
    expect(
      decideSignIn({ user: { email: "stranger@example.com" } }, env()),
    ).toEqual({ permitted: false, reason: "not-permitted" });
  });

  it("permits an address that is", () => {
    expect(decideSignIn({ user: { email: LISTED } }, env())).toEqual({
      permitted: true,
      email: LISTED,
    });
  });

  it("compares case-insensitively and ignores surrounding whitespace", () => {
    expect(
      decideSignIn(
        { user: { email: "  Owner@Example.COM " } },
        env({ [PERMITTED_EMAILS_VAR]: "  OWNER@example.com  " }),
      ).permitted,
    ).toBe(true);
  });
});

describe("decideSignIn and the absent email", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace", "   "],
  ])("refuses a %s email even against a list of blank entries", (_, email) => {
    // The trap: a list whose entries normalise to "" plus a user whose email
    // normalises to "" would match if either side were allowed to be the
    // empty string. Both guards are here; this pins the comparison's own.
    expect(
      decideSignIn(
        { user: { email } },
        { [PERMITTED_EMAILS_VAR]: " , , ", ADMIN_BOOTSTRAP_EMAILS: "," },
      ),
    ).toEqual({ permitted: false, reason: "no-email" });
  });

  it("refuses an absent email against a real list too", () => {
    expect(decideSignIn({ user: {} }, env())).toEqual({
      permitted: false,
      reason: "no-email",
    });
  });
});

describe("decideSignIn trusts only what the provider verified", () => {
  // Family 2, "a check compares the wrong two things": authorising the
  // address on the list while admitting whatever the profile asserted.

  it("permits a listed address the provider vouches for", () => {
    // The needle-can-be-absent control for the two refusals below: same
    // fixture, verified claim, permitted.
    expect(
      decideSignIn(
        {
          user: { email: LISTED },
          profile: { email: LISTED, email_verified: true },
        },
        env(),
      ).permitted,
    ).toBe(true);
  });

  it.each([
    ["the boolean false", false],
    ["the string \"false\"", "false"],
  ])("refuses a listed address the provider marks unverified (%s)", (_, claim) => {
    expect(
      decideSignIn(
        {
          user: { email: LISTED },
          profile: { email: LISTED, email_verified: claim },
        },
        env(),
      ),
    ).toEqual({ permitted: false, reason: "unverified-email" });
  });

  it("judges the address the provider asserted, not the stale persisted one", () => {
    // The direction that matters: the STORED address is listed, the provider
    // now asserts something else, and the something else is not listed. If
    // the decision were made on `user.email` this would be permitted.
    expect(
      decideSignIn(
        {
          user: { email: LISTED },
          profile: { email: "someone-else@example.com", email_verified: true },
        },
        env(),
      ),
    ).toEqual({ permitted: false, reason: "not-permitted" });
  });

  it("is unbothered by a difference in case or whitespace", () => {
    expect(
      decideSignIn(
        {
          user: { email: LISTED },
          profile: { email: " OWNER@Example.com ", email_verified: true },
        },
        env(),
      ).permitted,
    ).toBe(true);
  });

  it("takes a profile with no email_verified claim at the provider's word", () => {
    // Facebook's Graph profile has no such field. Treating absence as
    // "unverified" would refuse every Facebook sign-in.
    expect(
      decideSignIn({ user: { email: LISTED }, profile: { email: LISTED } }, env())
        .permitted,
    ).toBe(true);
  });

  it("falls back to the persisted address when the provider asserts none", () => {
    // Facebook without the email permission. The fallback is what keeps the
    // "judge the asserted address" rule from refusing every such sign-in.
    expect(
      decideSignIn(
        // Shaped like a real Facebook Graph profile with the email
        // permission withheld: an id and a name, and no email at all.
        { user: { email: LISTED }, profile: { id: "12345", name: "A Person" } },
        env(),
      ).permitted,
    ).toBe(true);
  });

  it("does not require a profile at all", () => {
    expect(decideSignIn({ user: { email: LISTED } }, env()).permitted).toBe(
      true,
    );
  });
});

describe("a changed provider address is recoverable from configuration", () => {
  /*
    PR #45 round 2, medium. @auth/core links an account by providerAccountId
    and never refreshes User.email for an already-linked OAuth account, so
    once someone changes their Google address they arrive with a stale row
    and a fresh profile on EVERY subsequent sign-in — permanently.

    The first version of this module compared the two and refused on any
    difference, and did it BEFORE consulting the permitted set. The
    documented remedy ("add the new address") therefore did nothing, and on
    a single-operator instance that was a permanent self-lockout of the only
    operator with no configuration-level escape.

    These tests pin the remedy, not just the branch. Both run the same
    fixture — the operator, mid-address-change — and differ only in what the
    operator has put in the allowlist.
  */
  const STALE_ROW = { email: "operator-old@example.com" };
  const FRESH_PROFILE = {
    email: "operator-new@example.com",
    email_verified: true,
  };
  const attempt = { user: STALE_ROW, profile: FRESH_PROFILE };

  it("is refused while the allowlist names only the old address", () => {
    const decision = decideSignIn(attempt, {
      [PERMITTED_EMAILS_VAR]: STALE_ROW.email,
    });

    // `not-permitted`, specifically: a refusal the operator can act on. Any
    // reason that does not consult the permitted set is by definition one
    // that editing the permitted set cannot fix, which is the whole bug.
    expect(decision).toEqual({ permitted: false, reason: "not-permitted" });
  });

  it("and is permitted the moment the operator adds the new one", () => {
    // THE REMEDY, as documented in env.example and docs/access-control.md.
    // Same fixture, one variable changed.
    expect(
      decideSignIn(attempt, {
        [PERMITTED_EMAILS_VAR]: `${STALE_ROW.email}, ${FRESH_PROFILE.email}`,
      }),
    ).toEqual({ permitted: true, email: FRESH_PROFILE.email });

    // And the old address is not load-bearing — dropping it still works, so
    // the operator is not obliged to keep a dead address listed forever.
    expect(
      decideSignIn(attempt, { [PERMITTED_EMAILS_VAR]: FRESH_PROFILE.email })
        .permitted,
    ).toBe(true);
  });

  it("still refuses the changed address when the provider will not vouch for it", () => {
    // Recoverability must not have cost the verification check: same
    // address-change fixture, allowlist naming the new address, but the
    // provider says it is unverified.
    expect(
      decideSignIn(
        { user: STALE_ROW, profile: { ...FRESH_PROFILE, email_verified: false } },
        { [PERMITTED_EMAILS_VAR]: FRESH_PROFILE.email },
      ),
    ).toEqual({ permitted: false, reason: "unverified-email" });
  });

  it("never refuses for a reason the permitted set cannot influence", () => {
    // The property behind all of the above, stated once. Across every
    // combination of stored/asserted address, the only refusals possible for
    // a verified address are the two the operator can fix by editing
    // configuration. `no-email` is excluded by both addresses being present.
    const recoverable = new Set(["no-configuration", "not-permitted"]);
    const seen = { permitted: 0, refused: 0 };
    for (const stored of [STALE_ROW.email, FRESH_PROFILE.email]) {
      for (const asserted of [STALE_ROW.email, FRESH_PROFILE.email]) {
        for (const configured of [
          undefined,
          STALE_ROW.email,
          FRESH_PROFILE.email,
        ]) {
          const decision = decideSignIn(
            {
              user: { email: stored },
              profile: { email: asserted, email_verified: true },
            },
            { [PERMITTED_EMAILS_VAR]: configured },
          );
          if (decision.permitted) {
            seen.permitted += 1;
          } else {
            seen.refused += 1;
            expect(recoverable).toContain(decision.reason);
          }
        }
      }
    }

    // Without this the loop above is a family-3 assertion: if every
    // combination came back permitted, the `expect` inside it would never
    // run and the test would pass by never looking at anything. Both
    // outcomes have to actually occur for the property to mean something.
    expect(seen.refused).toBeGreaterThan(0);
    expect(seen.permitted).toBeGreaterThan(0);
  });
});

describe("isPermittedSignIn", () => {
  it("answers with a boolean, never undefined", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    // A callback that returns undefined ALLOWS the sign-in in Auth.js, which
    // is how the defect worked. Both answers are asserted to be booleans.
    expect(isPermittedSignIn({ user: { email: LISTED } }, env())).toBe(true);
    expect(
      isPermittedSignIn({ user: { email: "stranger@example.com" } }, env()),
    ).toBe(false);
  });

  it("logs an unconfigured instance as an error naming the variable", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(isPermittedSignIn({ user: { email: LISTED } }, {})).toBe(false);

    expect(error).toHaveBeenCalledTimes(1);
    const message = String(error.mock.calls[0][0]);
    expect(message).toContain(PERMITTED_EMAILS_VAR);
    expect(message).toContain("nobody may sign in");
  });

  it("logs the domain of a refused address, not the address", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      isPermittedSignIn({ user: { email: "private.person@gmail.com" } }, env()),
    ).toBe(false);

    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("@gmail.com");
    expect(message).not.toContain("private.person");
  });

  it("names unusable entries on a refusal, so a list that permits nobody says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(
      isPermittedSignIn(
        { user: { email: "someone@example.com" } },
        { [PERMITTED_EMAILS_VAR]: "*@example.com" },
      ),
    ).toBe(false);

    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("*@example.com");
    expect(message).toContain("wildcards are not supported");
  });

  it("says nothing on a permitted sign-in", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(isPermittedSignIn({ user: { email: LISTED } }, env())).toBe(true);

    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});

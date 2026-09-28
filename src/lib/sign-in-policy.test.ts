import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PERMITTED_EMAILS_VAR,
  type SignInEnv,
  decideSignIn,
  isPermittedSignIn,
  permittedIdentities,
} from "@/lib/sign-in-policy";

/**
 * ugcportal-egp K1: who may sign in comes from configuration, and with no
 * configuration nobody may.
 *
 * Every test passes its own `env` object rather than mutating process.env, so
 * a developer or CI runner who happens to export ALLOWED_SIGNIN_EMAILS cannot
 * change an answer here. The one test that exercises the process.env default
 * says so and restores it.
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

  it("unions in ADMIN_BOOTSTRAP_EMAILS, so the bootstrap list is always a subset", () => {
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

  it("refuses when the profile names a different address than the one being authorised", () => {
    // The account being signed in to is the listed one; the provider just
    // verified something else. Authorising A while admitting B is the bug.
    expect(
      decideSignIn(
        {
          user: { email: LISTED },
          profile: { email: "someone-else@example.com", email_verified: true },
        },
        env(),
      ),
    ).toEqual({ permitted: false, reason: "email-mismatch" });
  });

  it("does not call a difference in case or whitespace a mismatch", () => {
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

  it("does not require a profile at all", () => {
    expect(decideSignIn({ user: { email: LISTED } }, env()).permitted).toBe(
      true,
    );
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

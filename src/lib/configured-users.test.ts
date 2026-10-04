import { describe, expect, it } from "vitest";

import { CONFIGURED_USERS, type ConfiguredUser } from "@/config/users";
import {
  configuredIdentities,
  configuredUserHandle,
  configuredUserProblems,
  findConfiguredUser,
} from "@/lib/configured-users";
import {
  PERMITTED_EMAILS_VAR,
  type SignInEnv,
  decideSignIn,
  permittedIdentities,
} from "@/lib/sign-in-policy";

/**
 * The committed users array as the gate and the linking read it
 * (ugcportal-t33p K3 and the lookup half of K5).
 *
 * This file deliberately does NOT mock src/config/users.ts the way
 * src/lib/sign-in-policy.test.ts does: three of its describes drive the real
 * array, because "the four identities Eirik actually configured are the four
 * identities that can sign in" is the claim nobody else makes. The rest
 * inject fixtures, so each rule is stated against data the test controls.
 */

const EIRIK_GOOGLE = "eiriksanderfjeld@gmail.com";
const EIRIK_FACEBOOK = "eirik@sander-fjeld.com";
const GRY_FACEBOOK = "gry@sander-fjeld.no";
const AUGUST_GOOGLE = "augustsanderfjeld@gmail.com";

/** A fixture array, so a rule is stated against data this file owns. */
const FIXTURE: readonly ConfiguredUser[] = [
  {
    name: "Ada",
    identities: ["google:ada@example.com", "facebook:ada@other.example.com"],
  },
  { name: "Grace", identities: ["facebook:grace@example.com"] },
];

/** No environment at all: the array is the only source of permission. */
const NO_ENV: SignInEnv = {};

function attempt(email: string, provider: string) {
  return {
    user: { email },
    account: { provider },
    profile: { email },
  };
}

describe("the array's identities are permitted in addition to the env vars (K3)", () => {
  it("permits an identity that appears ONLY in the array", () => {
    // The whole point of K3: adding a person to src/config/users.ts is the
    // one step that admits them. Nothing is set in the environment here.
    expect(decideSignIn(attempt("ada@example.com", "google"), NO_ENV, FIXTURE)).toEqual(
      { permitted: true, email: "ada@example.com" },
    );
    expect(
      decideSignIn(attempt("grace@example.com", "facebook"), NO_ENV, FIXTURE),
    ).toEqual({ permitted: true, email: "grace@example.com" });
  });

  it("refuses the SAME address through the other provider, with wrong-provider", () => {
    // The mutation this criterion asks for, as a test rather than as a
    // manual step: one field of the attempt changes — the provider — and
    // the answer flips. Every identity in the array is provider-bound by
    // construction, so an unbound reading of it would permit this.
    expect(
      decideSignIn(attempt("ada@example.com", "facebook"), NO_ENV, FIXTURE),
    ).toEqual({ permitted: false, reason: "wrong-provider" });
    expect(
      decideSignIn(attempt("grace@example.com", "google"), NO_ENV, FIXTURE),
    ).toEqual({ permitted: false, reason: "wrong-provider" });
  });

  it("refuses somebody the array does not list, with nothing else configured", () => {
    // The control: the needle (`permitted: true`) is absent for a stranger,
    // so the permissions above are not "everything is permitted".
    expect(
      decideSignIn(attempt("stranger@example.com", "google"), NO_ENV, FIXTURE),
    ).toEqual({ permitted: false, reason: "not-permitted" });
  });

  it("keeps ALLOWED_SIGNIN_EMAILS working alongside it, in both directions", () => {
    // A union, not a replacement: the env var still admits somebody who is
    // in no array, and the array still admits somebody no env var names.
    const env = { [PERMITTED_EMAILS_VAR]: "colleague@example.com" };

    expect(decideSignIn(attempt("colleague@example.com", "google"), env, FIXTURE))
      .toEqual({ permitted: true, email: "colleague@example.com" });
    expect(decideSignIn(attempt("ada@example.com", "google"), env, FIXTURE))
      .toEqual({ permitted: true, email: "ada@example.com" });
  });

  it("reports the array's addresses in the permitted set, and marks it configured", () => {
    const identities = permittedIdentities(NO_ENV, FIXTURE);

    expect(identities.configured).toBe(true);
    expect(identities.emails).toEqual([
      "ada@example.com",
      "ada@other.example.com",
      "grace@example.com",
    ]);
    expect(identities.malformed).toEqual([]);
  });

  it("reports an unusable identity as malformed rather than permitting it", () => {
    // Same bargain the env-var parser makes: an entry that permits nobody is
    // named rather than silently dropped.
    const identities = permittedIdentities(NO_ENV, [
      { name: "Bad", identities: ["google:*@example.com"] },
    ]);

    expect(identities.emails).toEqual([]);
    expect(identities.malformed).toEqual(["google:*@example.com"]);
    expect(
      decideSignIn(attempt("anyone@example.com", "google"), NO_ENV, [
        { name: "Bad", identities: ["google:*@example.com"] },
      ]),
    ).toEqual({ permitted: false, reason: "not-permitted" });
  });

  it("permits every identity in the REAL committed array, through its own provider", () => {
    // Against src/config/users.ts itself, with no environment: the four
    // addresses this instance is actually configured for.
    for (const [email, provider] of [
      [EIRIK_GOOGLE, "google"],
      [EIRIK_FACEBOOK, "facebook"],
      [GRY_FACEBOOK, "facebook"],
      [AUGUST_GOOGLE, "google"],
    ] as const) {
      expect(decideSignIn(attempt(email, provider), NO_ENV)).toEqual({
        permitted: true,
        email,
      });
      // And the same address through the other provider is refused — the
      // binding is real for the committed data, not only for fixtures.
      const other = provider === "google" ? "facebook" : "google";
      expect(decideSignIn(attempt(email, other), NO_ENV)).toEqual({
        permitted: false,
        reason: "wrong-provider",
      });
    }
  });

  it("names nobody outside the array in the real permitted set", () => {
    expect([...permittedIdentities(NO_ENV).emails].sort()).toEqual(
      [EIRIK_FACEBOOK, EIRIK_GOOGLE, GRY_FACEBOOK, AUGUST_GOOGLE].sort(),
    );
  });
});

describe("findConfiguredUser matches an exact (provider, address) pair (K5)", () => {
  it("finds the person for each of their identities", () => {
    expect(
      findConfiguredUser({ provider: "google", email: "ada@example.com" }, FIXTURE)
        ?.name,
    ).toBe("Ada");
    expect(
      findConfiguredUser(
        { provider: "facebook", email: "ada@other.example.com" },
        FIXTURE,
      )?.name,
    ).toBe("Ada");
  });

  it("does not match on the provider alone", () => {
    // `google:` is Ada's prefix; a different address through it is nobody.
    expect(
      findConfiguredUser({ provider: "google", email: "eve@example.com" }, FIXTURE),
    ).toBeNull();
  });

  it("does not match on the address alone — the other provider is nobody", () => {
    // The pair, not either half. Ada is `google:ada@example.com`; the same
    // address through Facebook is not Ada, and linking it to her would be
    // precisely K5's "two different people merged into one user".
    expect(
      findConfiguredUser({ provider: "facebook", email: "ada@example.com" }, FIXTURE),
    ).toBeNull();
  });

  it("does not match on the e-mail domain", () => {
    // `@example.com` is the domain of two listed addresses. Nothing here
    // reads a domain; a domain rule is the mechanism this repo has
    // deliberately not implemented (docs/access-control.md).
    expect(
      findConfiguredUser({ provider: "google", email: "anyone@example.com" }, FIXTURE),
    ).toBeNull();
    expect(
      findConfiguredUser({ provider: "google", email: "@example.com" }, FIXTURE),
    ).toBeNull();
  });

  it("yields nobody for an unlisted identity, so nothing can be linked to it", () => {
    expect(
      findConfiguredUser(
        { provider: "google", email: "stranger@example.com" },
        FIXTURE,
      ),
    ).toBeNull();
  });

  it("yields nobody for an absent, blank or unrecognised half", () => {
    // Fails closed on every shape the adapter could be handed: a sign-in
    // with no identity in scope must link nothing rather than match the
    // first entry.
    for (const identity of [
      { provider: null, email: "ada@example.com" },
      { provider: "google", email: null },
      { provider: "google", email: "   " },
      { provider: "  ", email: "ada@example.com" },
      { provider: "twitter", email: "ada@example.com" },
      {},
    ]) {
      expect(findConfiguredUser(identity, FIXTURE)).toBeNull();
    }
  });

  it("normalises case and surrounding space on both halves", () => {
    // The gate lowercases what it judges, so the linking has to agree or a
    // permitted sign-in would find nobody and silently get its own user.
    expect(
      findConfiguredUser(
        { provider: " GOOGLE ", email: "  Ada@Example.COM " },
        FIXTURE,
      )?.name,
    ).toBe("Ada");
  });

  it("refuses to read an identity whose provider half is missing", () => {
    // `ConfiguredIdentity` has no unbound form, but the runtime must not
    // rely on the type: a bare address here would match through either
    // provider. Cast, because writing it is exactly what the type prevents.
    const unbound = [
      { name: "Loose", identities: ["ada@example.com"] },
    ] as unknown as readonly ConfiguredUser[];

    expect(findConfiguredUser({ provider: "google", email: "ada@example.com" }, unbound))
      .toBeNull();
    expect(configuredIdentities(unbound[0])).toEqual([]);
  });

  it("matches each identity of the REAL array to the right person", () => {
    expect(findConfiguredUser({ provider: "google", email: EIRIK_GOOGLE })?.name)
      .toBe("Eirik");
    expect(findConfiguredUser({ provider: "facebook", email: EIRIK_FACEBOOK })?.name)
      .toBe("Eirik");
    expect(findConfiguredUser({ provider: "facebook", email: GRY_FACEBOOK })?.name)
      .toBe("Gry");
    expect(findConfiguredUser({ provider: "google", email: AUGUST_GOOGLE })?.name)
      .toBe("August");
  });
});

describe("configuredUserHandle", () => {
  it("derives a stable handle from the name", () => {
    expect(configuredUserHandle({ name: "Eirik", identities: [] })).toBe("eirik");
    expect(configuredUserHandle({ name: "Mary Ann", identities: [] })).toBe("mary-ann");
  });

  it("does not change when identities are added or reordered", () => {
    // The reason the handle comes from the name and not from the
    // identities: adding a provider to a person is the edit this feature
    // exists to make safe, and it must not move their user row.
    const before = configuredUserHandle({
      name: "Ada",
      identities: ["google:ada@example.com"],
    });
    const after = configuredUserHandle({
      name: "Ada",
      identities: ["facebook:ada@other.example.com", "google:ada@example.com"],
    });

    expect(after).toBe(before);
  });

  it("transliterates Norwegian letters rather than dropping them", () => {
    expect(configuredUserHandle({ name: "Bjørn", identities: [] })).toBe("bjorn");
    expect(configuredUserHandle({ name: "Åse Æble", identities: [] })).toBe("ase-aeble");
  });

  it("answers null for a name with nothing usable in it", () => {
    // Not "" — a blank handle is a value the UNIQUE index accepts once,
    // which would silently adopt the first such person and fail for the
    // second.
    expect(configuredUserHandle({ name: "", identities: [] })).toBeNull();
    expect(configuredUserHandle({ name: " --- ", identities: [] })).toBeNull();
  });

  it("gives the real array three distinct handles", () => {
    const handles = CONFIGURED_USERS.map(configuredUserHandle);

    expect(handles).toEqual(["eirik", "gry", "august"]);
    expect(new Set(handles).size).toBe(handles.length);
  });
});

describe("configuredUserProblems reports what is wrong with the array", () => {
  it("says nothing about the real committed array", () => {
    expect(configuredUserProblems()).toEqual([]);
  });

  it("reports an identity listed under two users", () => {
    const problems = configuredUserProblems([
      { name: "Ada", identities: ["google:shared@example.com"] },
      { name: "Grace", identities: ["google:shared@example.com"] },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("google:shared@example.com");
    expect(problems[0]).toContain("Ada");
    expect(problems[0]).toContain("Grace");
  });

  it("does not report the same address under two DIFFERENT providers", () => {
    // Two identities, not one duplicated: a person may well hold the same
    // address at both providers, and that is two rows in the array by
    // design. Reporting it would train the operator to ignore this check.
    expect(
      configuredUserProblems([
        {
          name: "Ada",
          identities: ["google:ada@example.com", "facebook:ada@example.com"],
        },
      ]),
    ).toEqual([]);
  });

  it("reports an unknown provider", () => {
    const problems = configuredUserProblems([
      { name: "Ada", identities: ["twitter:ada@example.com"] },
    ] as unknown as readonly ConfiguredUser[]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("names no known provider");
    expect(problems[0]).toContain("twitter:ada@example.com");
  });

  it("reports a user with no identities", () => {
    const problems = configuredUserProblems([{ name: "Ada", identities: [] }]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("has no identities");
    expect(problems[0]).toContain("Ada");
  });

  it("reports a malformed identity separately from an unknown provider", () => {
    // Two different typos with two different fixes. Telling them apart is
    // the whole value of the message over "entry ignored".
    const problems = configuredUserProblems([
      {
        name: "Ada",
        identities: ["google:*@example.com", "google:", "google:not-an-address"],
      },
    ]);

    expect(problems).toHaveLength(3);
    for (const problem of problems) {
      expect(problem).toContain("not one exact email address");
      expect(problem).not.toContain("names no known provider");
    }
  });

  it("reports two names that would collide on one handle", () => {
    // `User.configuredHandle` is UNIQUE, so this is a P2002 at the second
    // person's first sign-in if it is not caught here.
    const problems = configuredUserProblems([
      { name: "Mary Ann", identities: ["google:a@example.com"] },
      { name: "mary-ann", identities: ["facebook:b@example.com"] },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('handle "mary-ann"');
  });

  it("reports a name that yields no handle at all", () => {
    const problems = configuredUserProblems([
      { name: "???", identities: ["google:a@example.com"] },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no usable handle");
  });
});

import { describe, expect, it } from "vitest";

import { CONFIGURED_USERS, type ConfiguredUser } from "@/config/users";
import {
  PERMITTED_EMAILS_VAR,
  type SignInEnv,
  configuredIdentities,
  configuredUserHandle,
  configuredUserProblems,
  decideSignIn,
  findConfiguredUser,
  permittedIdentities,
  reviewConfiguredUsers,
} from "@/lib/sign-in-policy";

/**
 * The committed users array as the gate and the linking read it
 * (ugcportal-t33p K3 and the lookup half of K5).
 *
 * The code under test moved into src/lib/sign-in-policy.ts in PR #98's
 * first review round: the array's REVIEW now decides what is permitted, so
 * it and the permitted set cannot live in two modules without a cycle. This
 * file keeps its name because it still tests one feature — the array.
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

  it("permits nobody for an unusable identity, and reports it by its own file", () => {
    // PROVENANCE (PR #98 review, low 3). `malformed` is the list the boot
    // message attributes to ALLOWED_SIGNIN_EMAILS/ADMIN_BOOTSTRAP_EMAILS, so
    // an array identity must not land in it under a message naming the wrong
    // place to go and fix it. The review removes it first, and reports it
    // naming src/config/users.ts.
    const users: readonly ConfiguredUser[] = [
      { name: "Bad", identities: ["google:*@example.com"] },
    ];
    const identities = permittedIdentities(NO_ENV, users);

    expect(identities.emails).toEqual([]);
    expect(identities.malformed).toEqual([]);

    const problems = configuredUserProblems(users);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("google:*@example.com");
    expect(problems[0]).toContain("src/config/users.ts");

    expect(
      decideSignIn(attempt("anyone@example.com", "google"), NO_ENV, users),
    ).toEqual({ permitted: false, reason: "no-configuration" });
  });

  it("still attributes an unusable ENV entry to the environment", () => {
    // The other half of the same split: `malformed` keeps exactly the
    // entries the boot message is entitled to blame on a variable.
    const identities = permittedIdentities(
      { [PERMITTED_EMAILS_VAR]: "*@example.com" },
      FIXTURE,
    );

    expect(identities.malformed).toEqual(["*@example.com"]);
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

describe("what the review reports, it also removes (PR #98 round 1, medium 2)", () => {
  it("drops a duplicated identity from every claimant, not just the second", () => {
    // Nothing can tell which of them meant it, so neither gets it. Dropping
    // only the later one would make the array's ORDER decide who owns a
    // disputed identity, which is the quietest possible way to merge two
    // people.
    const { sound, problems } = reviewConfiguredUsers([
      {
        name: "Ada",
        identities: ["google:shared@example.com", "google:ada@example.com"],
      },
      { name: "Grace", identities: ["google:shared@example.com"] },
    ]);

    expect(problems).toHaveLength(1);
    expect(sound.flatMap((user) => user.identities)).toEqual([
      "google:ada@example.com",
    ]);
    expect(findConfiguredUser(
      { provider: "google", email: "shared@example.com" },
      [
        {
          name: "Ada",
          identities: ["google:shared@example.com", "google:ada@example.com"],
        },
        { name: "Grace", identities: ["google:shared@example.com"] },
      ],
    )).toBeNull();
  });

  it("drops a duplicate written with different SPACING from both of them", () => {
    // PR #98 round 2, medium 1. `parsePermittedEntry` trims around the
    // colon, so these two strings are one identity — the duplicate check saw
    // that and reported it. The filter did not: it asked whether
    // `"google: shared@example.com"` (inner space and all) was in the
    // unsound set, which held the PARSED key, so Ada kept the identity the
    // report had just removed and the address signed in as her.
    const users: readonly ConfiguredUser[] = [
      { name: "Ada", identities: ["google: shared@example.com"] },
      { name: "Grace", identities: ["google:shared@example.com"] },
    ];
    const { sound, problems } = reviewConfiguredUsers(users);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("more than one");
    // Nobody keeps it...
    expect(sound).toEqual([]);
    // ...nobody is found by it...
    expect(
      findConfiguredUser(
        { provider: "google", email: "shared@example.com" },
        users,
      ),
    ).toBeNull();
    // ...and it is not permitted either.
    expect(permittedIdentities(NO_ENV, users).emails).toEqual([]);
    expect(
      decideSignIn(attempt("shared@example.com", "google"), NO_ENV, users),
    ).toEqual({ permitted: false, reason: "no-configuration" });
  });

  it("hands out one canonical spelling, whatever spacing was written", () => {
    // Why the above cannot come back: `sound` no longer carries the raw
    // strings at all. Everything downstream sees the parser's own spelling,
    // so there is no second form for a later comparison to miss.
    const { sound } = reviewConfiguredUsers([
      { name: "Ada", identities: ["google:  Ada@Example.COM  "] },
    ]);

    expect(sound).toEqual([
      { name: "Ada", identities: ["google:ada@example.com"] },
    ]);
  });

  it("drops both people whose names collide on one handle", () => {
    const users: readonly ConfiguredUser[] = [
      { name: "Kari", identities: ["facebook:kari@example.com"] },
      { name: "KARI ", identities: ["google:kari@example.com"] },
    ];
    const { sound } = reviewConfiguredUsers(users);

    expect(sound).toEqual([]);
    expect(
      findConfiguredUser({ provider: "facebook", email: "kari@example.com" }, users),
    ).toBeNull();
    expect(permittedIdentities(NO_ENV, users).emails).toEqual([]);
  });

  it("drops a person whose handle would lose a letter", () => {
    const users: readonly ConfiguredUser[] = [
      { name: "Łukasz", identities: ["google:lukasz@example.com"] },
    ];

    expect(reviewConfiguredUsers(users).sound).toEqual([]);
    expect(
      findConfiguredUser({ provider: "google", email: "lukasz@example.com" }, users),
    ).toBeNull();
  });

  it("keeps a sound person beside an unsound one", () => {
    // The control for all three above: removal is targeted, not a sulk. One
    // broken entry must not take the rest of the household offline.
    const users: readonly ConfiguredUser[] = [
      { name: "Nobody", identities: [] },
      { name: "Ada", identities: ["google:ada@example.com"] },
    ];
    const { sound } = reviewConfiguredUsers(users);

    expect(sound.map((user) => user.name)).toEqual(["Ada"]);
    expect(
      findConfiguredUser({ provider: "google", email: "ada@example.com" }, users)
        ?.name,
    ).toBe("Ada");
  });

  it("leaves the real committed array entirely sound", () => {
    const { sound, problems } = reviewConfiguredUsers();

    expect(problems).toEqual([]);
    expect(sound).toEqual(CONFIGURED_USERS);
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

  it("reports a name whose handle would silently drop a letter", () => {
    // PR #98 review, low 2. `Łukasz` becomes `ukasz`: stable and unique and
    // not his name — and one keystroke from colliding with a real `Ukasz`.
    const problems = configuredUserProblems([
      { name: "Łukasz", identities: ["google:lukasz@example.com"] },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"ł"');
    expect(problems[0]).toContain('becomes "ukasz"');
    expect(problems[0]).toContain("TRANSLITERATIONS");
  });

  it("does not report a letter it knows how to transliterate", () => {
    // The control: `ø` is in the map, so `Bjørn` is sound. Without this the
    // check above could be "every non-ASCII name is reported", which would
    // flag the operator's own household.
    expect(
      configuredUserProblems([
        { name: "Bjørn", identities: ["google:bjorn@example.com"] },
      ]),
    ).toEqual([]);
  });

  it("does not report punctuation, which is a separator by design", () => {
    expect(
      configuredUserProblems([
        { name: "Mary-Ann O'Brien Jr.", identities: ["google:m@example.com"] },
      ]),
    ).toEqual([]);
  });

  it("reports a name that yields no handle at all", () => {
    const problems = configuredUserProblems([
      { name: "???", identities: ["google:a@example.com"] },
    ]);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no usable handle");
  });
});

import { CONFIGURED_USERS, type ConfiguredUser } from "@/config/users";
import {
  PROVIDER_PREFIX_HINT,
  type SignInProvider,
  normalizeString,
  parsePermittedEntry,
  providerId,
} from "@/lib/sign-in-policy";

/**
 * Reading the committed users array (src/config/users.ts): which identity is
 * whose, what a person's stable handle is, and what is wrong with the array
 * (ugcportal-t33p).
 *
 * DELIBERATELY FREE OF PRISMA and of every provider module, for the same
 * reason src/lib/sign-in-policy.ts is: src/instrumentation.ts imports this
 * one for the boot check, including in the Edge instrumentation bundle where
 * the Prisma client cannot be loaded at all. The half that writes to the
 * database — the adapter wrapper that attaches an Account row to the right
 * User — is src/lib/configured-user-link.ts, which imports this.
 *
 * Imports sign-in-policy and is never imported BY it, which is what keeps
 * the two from forming a cycle: the policy folds the array's identity
 * strings into the permitted set through its own parser, and this module
 * reads the same strings through the same parser for a different question.
 */

/**
 * One identity, parsed: the provider id and the normalised address.
 *
 * Both halves are mandatory. An entry in the array that does not yield both
 * is not an identity — it is a configuration mistake, reported by
 * `configuredUserProblems` and matched by nothing.
 */
export type ConfiguredIdentityRef = {
  provider: SignInProvider;
  email: string;
};

/**
 * Letters this slug has an opinion about, because the operator is Norwegian
 * and `Bjørn` would otherwise become `bj-rn` — a handle that is stable and
 * correct but reads like a bug, which is the kind of thing somebody later
 * "fixes" and thereby orphans a user row. Mapped explicitly rather than
 * through `normalize("NFKD")`, which decomposes `å` but leaves `ø` and `æ`
 * alone, so the result would be inconsistent between two letters a reader
 * thinks of as one family.
 */
const TRANSLITERATIONS: ReadonlyMap<string, string> = new Map([
  ["æ", "ae"],
  ["ø", "o"],
  ["å", "a"],
  ["ä", "a"],
  ["ö", "o"],
  ["ü", "u"],
  ["é", "e"],
  ["è", "e"],
  ["ß", "ss"],
]);

/**
 * The stable handle for one configured person: the key their single `User`
 * row is found by (`User.configuredHandle`).
 *
 * DERIVED FROM `name`, AND THAT IS THE WHOLE DESIGN DECISION. The bead asks
 * for a handle "derived from the array, not from e-mail", and the array has
 * exactly one field that identifies the person independently of any
 * provider: their name. Deriving it from the identities instead — the first
 * one listed, or a hash of all of them — would make adding or reordering a
 * person's identities change their handle, which is the one edit this
 * feature exists to make safe.
 *
 * The cost, stated so nobody has to discover it: RENAMING a person changes
 * their handle, and the next sign-in then finds no row and creates a second,
 * empty user — the exact split this bead removes. It is not detectable at
 * boot (the check in src/instrumentation.ts has no database in the Edge
 * bundle), so it is documented instead, with the one-line `UPDATE` that
 * makes a rename safe, under "Renaming a person" in docs/access-control.md.
 *
 * `null` for a name that yields no usable handle at all (empty, or nothing
 * but punctuation). Not an empty string: a blank handle would be a value
 * `User.configuredHandle`'s UNIQUE index happily accepts once, silently
 * adopting the first such person and then failing for the second.
 */
export function configuredUserHandle(user: ConfiguredUser): string | null {
  const slug = [...user.name.toLowerCase()]
    .map((character) => TRANSLITERATIONS.get(character) ?? character)
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : null;
}

/**
 * The identities of one configured person, parsed; unusable ones dropped.
 *
 * Dropping rather than throwing, because this runs on the sign-in path and a
 * typo in one person's second address must not stop everyone else signing
 * in. The dropped entries are not silent: `configuredUserProblems` names
 * every one of them at boot, which is the same bargain the env-var parser
 * already makes with `malformed`.
 *
 * An entry whose provider half is missing is dropped too, even though
 * `ConfiguredIdentity` has no unbound form: the type constrains what can be
 * WRITTEN here, and this function is what the runtime relies on. An unbound
 * identity would match an address through either provider, which is the K5
 * failure ("two different people merged because they share an e-mail") one
 * careless edit away.
 */
export function configuredIdentities(
  user: ConfiguredUser,
): ConfiguredIdentityRef[] {
  const parsed: ConfiguredIdentityRef[] = [];
  for (const identity of user.identities) {
    const entry = parsePermittedEntry(identity.trim().toLowerCase());
    if (entry === null || entry.provider === null) {
      continue;
    }
    parsed.push({ provider: entry.provider, email: entry.email });
  }
  return parsed;
}

/**
 * Which configured person, if any, THIS (provider, address) pair is.
 *
 * EXACT ON BOTH HALVES (ugcportal-t33p K5). Not the domain, not the local
 * part, not the provider alone, and not the address alone — the two
 * together, each normalised the same way the gate normalises them
 * (`providerId` and `normalizeString`, imported rather than reimplemented,
 * so the string the gate permitted is the string matched here). An address
 * listed under `google:` is not this person when Facebook asserts it; that
 * sign-in is refused by the gate as `wrong-provider` long before this is
 * reached, and would find nobody here in any case.
 *
 * Linear over a handful of people, deliberately. This runs once per sign-in,
 * not per request, and an index built at module load would be a second
 * representation of the array to keep in step with the first for a loop over
 * three entries.
 *
 * `null` for anything not listed, which is the answer that makes an unlisted
 * identity take the unwrapped adapter path unchanged.
 */
export function findConfiguredUser(
  identity: { provider?: unknown; email?: unknown },
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): ConfiguredUser | null {
  const provider = providerId(identity.provider);
  const email = normalizeString(identity.email);
  if (provider === null || email === null) {
    return null;
  }
  for (const user of users) {
    for (const candidate of configuredIdentities(user)) {
      if (candidate.provider === provider && candidate.email === email) {
        return user;
      }
    }
  }
  return null;
}

/**
 * Everything wrong with the array, as lines an operator can act on
 * (ugcportal-t33p, scope item 5). Empty when the array is sound.
 *
 * A REPORT, NOT A REFUSAL. Same bargain as every other check in
 * src/instrumentation.ts: the public gallery is useful to a signed-out
 * visitor, and refusing to boot over one mistyped address would be a worse
 * failure than the one being reported. Every problem below either permits
 * nobody or affects one person, never widens access, and is fixed by an
 * edit to one file.
 *
 * The four the bead names, plus two about the handle. The handle ones are
 * here because `User.configuredHandle` is UNIQUE: two people whose names
 * slug to the same string would be a P2002 at the second person's first
 * sign-in — a failure at the worst possible moment, for a mistake that is
 * visible at boot.
 */
export function configuredUserProblems(
  users: readonly ConfiguredUser[] = CONFIGURED_USERS,
): string[] {
  const problems: string[] = [];
  /** Which people claim each identity, for the "under two users" check. */
  const claimants = new Map<string, string[]>();
  const handles = new Map<string, string[]>();

  for (const user of users) {
    const label = user.name.trim().length > 0 ? user.name : "(unnamed user)";

    if (user.identities.length === 0) {
      problems.push(
        `[auth] Configured user "${label}" has no identities, so nobody can ` +
          "sign in as them and no User row will ever be linked to them. " +
          `Give them at least one ${PROVIDER_PREFIX_HINT} identity in ` +
          "src/config/users.ts, or remove the entry.",
      );
    }

    const handle = configuredUserHandle(user);
    if (handle === null) {
      problems.push(
        `[auth] Configured user "${label}" has a name that yields no usable ` +
          "handle (it contains no letters or digits). Their identities " +
          "cannot be linked to a single User row. See src/config/users.ts.",
      );
    } else {
      handles.set(handle, [...(handles.get(handle) ?? []), label]);
    }

    for (const identity of user.identities) {
      const normalized = identity.trim().toLowerCase();
      const parsed = parsePermittedEntry(normalized);
      if (parsed === null || parsed.provider === null) {
        problems.push(describeUnusableIdentity(label, identity));
        continue;
      }
      const key = `${parsed.provider}:${parsed.email}`;
      claimants.set(key, [...(claimants.get(key) ?? []), label]);
    }
  }

  for (const [identity, names] of claimants) {
    if (names.length > 1) {
      problems.push(
        `[auth] The identity ${identity} is listed under more than one ` +
          `configured user (${names.join(", ")}). Whoever is listed first ` +
          "wins, so one of those people would sign in as the other. Remove " +
          "the duplicate in src/config/users.ts.",
      );
    }
  }

  for (const [handle, names] of handles) {
    if (names.length > 1) {
      problems.push(
        `[auth] More than one configured user has the handle "${handle}" ` +
          `(${names.join(", ")}). The handle is UNIQUE on User, so the ` +
          "second of them to sign in would fail. Give them distinguishable " +
          "names in src/config/users.ts.",
      );
    }
  }

  return problems;
}

/**
 * Why one identity string is unusable, told apart rather than lumped
 * together: an unknown provider and a malformed address are two different
 * typos with two different fixes, and "it is ignored" is useless to an
 * operator who cannot see which half is wrong.
 *
 * The provider half is judged by `providerId` — the same function the gate
 * canonicalises `account.provider` with — so the two cannot disagree about
 * what counts as a known provider.
 */
function describeUnusableIdentity(name: string, identity: string): string {
  const normalized = identity.trim().toLowerCase();
  const colon = normalized.indexOf(":");
  const prefix = colon === -1 ? "" : normalized.slice(0, colon).trim();
  if (colon === -1 || providerId(prefix) === null) {
    return (
      `[auth] Configured user "${name}" has the identity "${identity}", ` +
      `which names no known provider. Each identity must begin with ` +
      `${PROVIDER_PREFIX_HINT}. It permits nobody and links nothing. ` +
      "See src/config/users.ts."
    );
  }
  return (
    `[auth] Configured user "${name}" has the identity "${identity}", whose ` +
    "address is not one exact email address (wildcards, blanks and a second " +
    "provider prefix are all rejected). It permits nobody and links " +
    "nothing. See src/config/users.ts."
  );
}

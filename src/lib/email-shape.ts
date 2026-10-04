/**
 * Whether `value` looks like `local@domain.tld` — shape-only, not RFC 5322.
 *
 * Shared by src/lib/sign-in-policy.ts's own `isEmailShaped` (layered with
 * sign-in-specific exclusions for `*` and `:` — see that module's own
 * comment for why those two are rejected there and not here) and
 * src/lib/contact.ts's `isBareEmailAddress` (round-5 review: the two used
 * to carry separately maintained, near-identical regexes, and NEITHER one
 * rejected a TRAILING DOT in the domain — `"owner@example.com."` read as
 * shaped in both, because the domain's own character class allowed `.`
 * freely with nothing stopping one at the end).
 *
 * One regex, in one place, fixes that structurally rather than patching
 * the symptom onto a looser pattern: the domain is required to be one or
 * more non-empty, dot-SEPARATED labels (`(?:\.[^...]+)+` after the first
 * label), which forbids a leading dot, a trailing dot, and two dots in a
 * row all at once, because each of those would require an empty label
 * somewhere and no label here may be empty.
 *
 * Whitespace, `@`, `,` and the angle brackets are excluded from both the
 * local part and the domain. Whitespace and a second `@` because either
 * breaks the one-address shape outright; `,` because
 * `sign-in-policy.ts`'s permitted-email lists are comma-separated, so a
 * raw comma inside one entry would silently merge two entries into one
 * malformed-looking one; the angle brackets because `contact.ts` rejects a
 * `"Name <addr>"` value, and a trailing `<`/`>` with no embedded
 * whitespace (`"<jane@example.com>"`) would otherwise still read as
 * shaped.
 */
const EMAIL_SHAPE = /^[^\s@,<>]+@[^\s@,<>.]+(?:\.[^\s@,<>.]+)+$/;

export function isEmailShaped(value: string): boolean {
  return EMAIL_SHAPE.test(value);
}

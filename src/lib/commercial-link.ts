import type { CommercialLinkNetwork } from "@/generated/prisma/enums";
import {
  isPermittedAdvertisingLabel,
  PERMITTED_ADVERTISING_LABELS,
  type AdvertisingDisclosureFacts,
  type AdvertisingLabelRefusal,
} from "@/lib/advertising-disclosure";
import { hasUnsafeText } from "@/lib/media-rules";

/**
 * What a commercial outbound link may say (ugcportal-qnq9.2.1): where it
 * points, and which network it is routed through.
 *
 * NO PRISMA IMPORT, and no import that reaches one — the same claim
 * src/lib/alcohol-commerce.ts and src/lib/advertising-disclosure.ts make next
 * door. The one type imported from the generated client is an ENUM, which is
 * a plain union of string literals with no runtime client behind it (the
 * disclosure route imports `BenefitKind` the same way). These rules are
 * decidable from a string and an enum name, so a test of them should not need
 * a database.
 *
 * WHAT THIS IS NOT. The alcohol and brand half of the attach gate is NOT
 * here: `benefitAttachmentRefusal` (src/lib/alcohol-commerce.ts) owns it, as
 * the one function that decides what the three alcohol answers mean, and the
 * route calls it directly. What IS here, below the field validators, is
 * `commercialLinkDisclosureRefusal` — the rule that a link may only be
 * attached to an item that already declares a benefit under a permitted
 * label, which is this bead's own rule and nobody else's.
 */

/**
 * Longest destination this will store, measured on the CANONICAL form — see
 * `validateCommercialLinkUrl` for why the cap is measured there rather than
 * on what was submitted, and why that form needs no code-point counting.
 *
 * 2048 is the conventional ceiling, and the reason to take the convention
 * rather than a number of this module's own invention is that the value
 * leaves here and is consumed by things with their own limits — a `href`, a
 * redirect header, a log line, whatever an affiliate network itself accepts —
 * none of which this product controls or can test against. What the number
 * has to be ABOVE is set by the use: a network deep-link carries a merchant
 * id, a programme id, a click id and a percent-encoded destination, so a cap
 * chosen by eyeballing a short example would refuse the links this bead
 * exists to store. Not asserted as any particular consumer's limit, because
 * nothing here can check one.
 *
 * STRICT REJECTION ABOVE THE LIMIT, not truncation. A truncated URL is not a
 * shorter version of the same destination — it is a different one, or no
 * destination at all, and the operator would find out by clicking a link on
 * their own published page.
 */
export const MAX_COMMERCIAL_LINK_URL_LENGTH = 2048;

/**
 * Longest free-text network name, in code points, for `OTHER`.
 *
 * The same number `MAX_BENEFIT_SOURCE_NAME_LENGTH` uses and for the same
 * reason: this is a company's name ("Tradedoubler Nordic AB"), not a label,
 * and it is not a chip under a thumbnail. Not imported from
 * src/lib/benefit-source.ts, which pulls in the Prisma client and so would
 * undo this module's no-database claim above; they are two independent caps
 * that happen to agree, and neither is derived from the other.
 */
export const MAX_COMMERCIAL_LINK_NETWORK_OTHER_LENGTH = 64;

/**
 * How many commercial links one item may carry.
 *
 * A CAP RATHER THAN NO CAP, for the reason `MAX_TAGS_PER_ITEM`
 * (src/lib/media-rules.ts) gives for the other per-item collection an owner
 * writes: every permitted account can write these, so an unbounded list is an
 * unbounded write. The two collections grow differently, which is why each
 * needs its own number: a tag list is REPLACED whole by a PUT, so the length
 * the owner sends is the length they get, while a link list is grown one POST
 * at a time and only ever goes up until somebody detaches one. Attaching is not free — each
 * link needs a distinct destination and a brand that somebody has already
 * recorded a §3.1a answer against — so this is an authenticated owner filling
 * up their own item rather than an authorization hole. It is still a row
 * count with no ceiling on a table that ugcportal-qnq9.2.2 will read on every
 * public surface once it ships (today nothing public reads it).
 *
 * SIX, and the number is about the page rather than about the database. Each
 * link renders its own per-link advertising marker beside the item
 * (ugcportal-qnq9.2.2, §3.2's "and at each link" half), and a photograph with
 * a dozen markers under it is a disclosure nobody reads — the opposite of what
 * the rule asks for. Six objects is already more than one photograph can
 * honestly recommend, so this leaves room to be wrong about that without
 * leaving room to abuse it.
 *
 * NOT DERIVED FROM `MAX_TAGS_PER_ITEM`, which is also six. They are two
 * independent limits on two different things — one is how many chips fit
 * under a thumbnail, this one is how many advertising markers a reader will
 * tolerate — and tying them together would make changing either one change
 * the other for no reason.
 *
 * SERVER-ONLY, unlike `MAX_TAGS_PER_ITEM`, which lives in media-rules.ts so
 * the upload form can stop the operator before a whole video upload is spent
 * earning a 400. There is no form for this yet (ugcportal-qnq9.2.2 owns the
 * surface), and the request is a few hundred bytes of JSON, so there is
 * nothing for a browser-side copy of this number to save.
 */
export const MAX_COMMERCIAL_LINKS_PER_ITEM = 6;

/**
 * Every network the schema's `CommercialLinkNetwork` enum admits.
 *
 * The five the research document names (§2 step 5, §5.7 — Adtraction first
 * per §4 weeks 5-8) plus `OTHER`. `satisfies readonly CommercialLinkNetwork[]`
 * catches a name here that the schema does not have; the reverse direction —
 * a network added to the schema and not to this list — is closed by
 * commercial-link.test.ts comparing this against the generated enum's own
 * keys, the same pairing `BENEFIT_KINDS` uses.
 */
export const COMMERCIAL_LINK_NETWORKS = Object.freeze([
  "ADTRACTION",
  "AWIN",
  "PARTNER_ADS",
  "TRADEDOUBLER",
  "ADRECORD",
  "OTHER",
] as const satisfies readonly CommercialLinkNetwork[]);

/** The one member that carries its name in `networkOther` beside it. */
export const COMMERCIAL_LINK_NETWORK_OTHER = "OTHER";

/** Narrows an unknown to a `CommercialLinkNetwork`. */
export function isCommercialLinkNetwork(
  value: unknown,
): value is CommercialLinkNetwork {
  return (
    typeof value === "string" &&
    (COMMERCIAL_LINK_NETWORKS as readonly string[]).includes(value)
  );
}

/**
 * A validated field, or a refusal that says WHICH field to fix.
 *
 * `field` IS CARRIED HERE RATHER THAN SUPPLIED BY THE CALLER, which is the
 * one thing about this type worth arguing. A validator that covers two body
 * fields — `validateCommercialLinkNetwork` covers `network` and
 * `networkOther` — is the only thing that knows which of them a given refusal
 * is about, and a route that picks one name for all of them answers with a
 * `field` that contradicts its own `message`. The key exists so a caller can
 * find the input to correct; one that names the wrong input is worse than
 * none, because it reads as an answer.
 */
export type CommercialLinkFieldValidation<T> =
  | { ok: true; value: T }
  | { ok: false; message: string; field: string };

/**
 * Validates a submitted destination and returns the form that will be stored.
 *
 * THE CANONICAL `href` IS WHAT IS STORED, not the string that was submitted,
 * and that is the one choice in this function worth arguing. The renderer
 * (ugcportal-qnq9.2.2) will put this value in an `href`, so the value stored
 * must be the value that was actually parsed and found to be https — not a
 * string that merely happened to parse to one. Storing the raw input would
 * leave a gap between "what was checked" and "what gets clicked": the two
 * agree today, and would stop agreeing the moment anybody normalised either
 * side.
 *
 * SO THE LENGTH CAP IS MEASURED ON THE CANONICAL FORM TOO, for the same
 * reason — the cap is a promise about the column, and the column holds the
 * canonical form. Canonicalisation can lengthen a URL (a literal space
 * becomes `%20`), so a submission marginally under the cap can be refused for
 * being marginally over it, which is the honest way round: the alternative is
 * a cap that the stored value does not actually obey. Nothing unbounded ever
 * reaches the parser — the route caps the whole request body before it is
 * buffered.
 *
 * THE ORDER OF THE CHECKS IS LOAD-BEARING in exactly one place:
 * `hasUnsafeText` runs on the SUBMITTED string, BEFORE the parse. `new URL`
 * percent-encodes a bidi override or a zero-width character in a path or
 * query rather than rejecting it, so a check on the canonical form would pass
 * every time — the characters are still there, just spelled `%E2%80%AE`.
 * Screening the raw input is what actually refuses them, which is the same
 * denylist, from the same module, that the rename, tag, caption and brand-name
 * paths all go through (`hasUnsafeText`, src/lib/media-rules.ts).
 *
 * WHAT `https` ALONE RULES OUT. `javascript:` and `data:` parse perfectly
 * well as URLs and are refused here by being the wrong scheme, not by being
 * named — a denylist of dangerous schemes would need extending every time
 * somebody invents one, and an allowlist of exactly `https` needs extending
 * never. `http:` is refused too, and deliberately: a commercial link is an
 * outbound click from a published page carrying a tracking parameter, and
 * sending that over plaintext is not something this product should do. If a
 * network ever turns out to offer only an `http` link, that is a decision to
 * take deliberately and a change to this allowlist, not a reason to widen it
 * in advance for a case nobody has met.
 *
 * THERE IS NO SEPARATE HOSTNAME CHECK, and that is not an omission. `https`
 * is a "special scheme" in the URL standard, which requires a non-empty host:
 * `new URL("https://")` throws, so by the time `protocol` has been found to
 * be `https:` there is a host. An `if (url.hostname === "")` here would be a
 * branch no test could ever reach — this repo's recurring defect family 2 —
 * so it is stated here instead of written.
 *
 * EMBEDDED CREDENTIALS ARE REFUSED. `https://paypal.com@evil.example/` is a
 * link to `evil.example` that reads as a link to PayPal, and this value is
 * destined for a public page where the text beside it is the operator's own
 * recommendation. The userinfo component has no legitimate use in an
 * affiliate link, and it is also a credential that would be published.
 */
export function validateCommercialLinkUrl(
  value: unknown,
): CommercialLinkFieldValidation<string> {
  if (typeof value !== "string") {
    return { ok: false, message: "Field 'url' must be a string", field: "url" };
  }

  const submitted = value.trim();
  if (submitted.length === 0) {
    return { ok: false, message: "Field 'url' must not be empty", field: "url" };
  }

  if (hasUnsafeText(submitted)) {
    return {
      ok: false,
      message:
        "Field 'url' must not contain control or text-direction characters",
      field: "url",
    };
  }

  let url: URL;
  try {
    url = new URL(submitted);
  } catch {
    return {
      ok: false,
      message: "Field 'url' must be an absolute https:// URL",
      field: "url",
    };
  }

  if (url.protocol !== "https:") {
    return {
      ok: false,
      message: `Field 'url' must use https, not '${url.protocol}'`,
      field: "url",
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      message: "Field 'url' must not carry a username or password",
      field: "url",
    };
  }

  /*
   * `.length` RATHER THAN `Array.from(...).length`, which is the opposite of
   * what every other cap in this product does (MAX_TAG_NAME_LENGTH,
   * MAX_ALT_TEXT_LENGTH, MAX_BENEFIT_SOURCE_NAME_LENGTH, and the free-text
   * network name below all count code points so an astral character counts
   * as one). It is not an oversight: a canonical `href` is pure ASCII. The
   * URL standard's C0-control percent-encode set covers "all code points
   * greater than U+007E", so every non-ASCII character in a path, query or
   * fragment comes back percent-encoded and every non-ASCII host comes back
   * punycoded. There is therefore no code-point-versus-UTF-16-unit
   * distinction left to make here, and `Array.from` would be a conversion
   * that no input could ever change the answer of. The premise is pinned by
   * "the canonical form of an astral character is ASCII" in
   * commercial-link.test.ts rather than asserted in this comment.
   */
  const canonical = url.href;
  if (canonical.length > MAX_COMMERCIAL_LINK_URL_LENGTH) {
    return {
      ok: false,
      message: `Field 'url' must be at most ${MAX_COMMERCIAL_LINK_URL_LENGTH} characters`,
      field: "url",
    };
  }

  return { ok: true, value: canonical };
}

/**
 * Validates the network pair and returns the two columns to store.
 *
 * BOTH HALVES OF THE CONTRADICTION ARE REFUSED, rather than one being
 * silently repaired: `OTHER` with no name, and a named member carrying a
 * stray name. The second is the one that would be tempting to just drop, and
 * dropping it is what the disclosure route refuses to do with its own stray
 * fields and for the same reason — a 200 to a caller who believes they
 * recorded "Impact" against `ADTRACTION` leaves a row that says something
 * nobody meant, and the one person who could tell has moved on past the form.
 *
 * `null` AND `undefined` ARE THE SAME THING HERE, unlike on the disclosure's
 * `benefitReceived` where they mean opposite things. There is no answer to
 * withdraw: a network either is `OTHER` and has a name, or is one of the five
 * and has none.
 */
export function validateCommercialLinkNetwork(
  network: unknown,
  networkOther: unknown,
): CommercialLinkFieldValidation<{
  network: CommercialLinkNetwork;
  networkOther: string | null;
}> {
  if (!isCommercialLinkNetwork(network)) {
    return {
      ok: false,
      message: `Field 'network' must be one of: ${COMMERCIAL_LINK_NETWORKS.join(", ")}`,
      field: "network",
    };
  }

  if (network !== COMMERCIAL_LINK_NETWORK_OTHER) {
    if (networkOther !== undefined && networkOther !== null) {
      return {
        ok: false,
        message: `Field 'networkOther' may only be set when 'network' is ${COMMERCIAL_LINK_NETWORK_OTHER}`,
        field: "networkOther",
      };
    }
    return { ok: true, value: { network, networkOther: null } };
  }

  if (typeof networkOther !== "string") {
    return {
      ok: false,
      message: `Field 'networkOther' must name the network when 'network' is ${COMMERCIAL_LINK_NETWORK_OTHER}`,
      field: "networkOther",
    };
  }

  const name = networkOther.trim();
  if (name.length === 0) {
    return {
      ok: false,
      message: `Field 'networkOther' must name the network when 'network' is ${COMMERCIAL_LINK_NETWORK_OTHER}`,
      field: "networkOther",
    };
  }
  if (Array.from(name).length > MAX_COMMERCIAL_LINK_NETWORK_OTHER_LENGTH) {
    return {
      ok: false,
      message: `Field 'networkOther' must be at most ${MAX_COMMERCIAL_LINK_NETWORK_OTHER_LENGTH} characters`,
      field: "networkOther",
    };
  }
  if (hasUnsafeText(name)) {
    return {
      ok: false,
      message:
        "Field 'networkOther' must not contain control or text-direction characters",
      field: "networkOther",
    };
  }

  return { ok: true, value: { network, networkOther: name } };
}

/**
 * Whether this item's advertising disclosure forbids attaching a commercial
 * link to it, and why (ugcportal-qnq9.2.1 K3).
 *
 * THE INVERSE OF `advertisingLabelPublishRefusal`, NOT A COPY OF IT, and the
 * difference is the whole point of writing a second function instead of
 * reusing the first. That one asks "does this item's disclosure forbid
 * PUBLISHING", and an item nobody has declared a benefit for publishes
 * perfectly well — so it returns null for an absent row. This one asks "may a
 * commercial link be attached", and the answer for an absent row is NO. The
 * two are not the same question read from different sides; reusing the
 * publish gate here would have let a link be attached to an item with no
 * disclosure at all, which is precisely the unlabelled affiliate link
 * ugcportal-qnq9.2's K6 names as a Forbrukertilsynet breach.
 *
 * WHY A LINK REQUIRES A DECLARED BENEFIT WITH A PERMITTED LABEL. §3.2 wants a
 * page carrying affiliate links labelled at the top AND at each link. The
 * top-of-page label is rendered from `MediaAdvertisingDisclosure.label` and
 * from nothing else (src/lib/gallery-items.ts), so an item with no declared
 * benefit — or one whose label is not a permitted one — is an item on which a
 * commercial link would appear with no label above it. This refuses to create
 * that item.
 *
 * WHAT THAT GATES, AND WHAT IT DOES NOT, because the next reader of this
 * module is the renderer (ugcportal-qnq9.2.2) and the difference decides
 * whether it has to re-check. It gates the ATTACH: at the moment a link is
 * written, the item carries a declared benefit under a permitted label. It
 * holds nothing after that moment. PUT /api/media/[id]/disclosure with
 * `benefitReceived: false` is deliberately never refused ("WITHDRAWING A
 * BENEFIT IS NEVER REFUSED BY THAT GATE"), it clears `label`, and it names no
 * commercial link and detaches none — so an item can be left published,
 * carrying links, with no advertising label above them. Nothing downstream
 * notices: `commercialPublishRefusal` returns null as soon as
 * `benefitReceived` is not `true`, and the publish route selects no
 * `commercialLinks` relation at all, so neither the label check nor the § 9-2
 * check runs on that state. The counterexample is in this bead's own suite —
 * commercial-links/route.test.ts, "is never refused by the disclosure
 * precondition either", which builds exactly that row. So the top label's
 * presence is a property of THIS WRITE, not an invariant of the data, and a
 * renderer must not read it as one. Closing the gap — refusing the withdrawal
 * while links exist, detaching them with it, or re-checking at render — is
 * ugcportal-jain, not this bead.
 *
 * THE LABEL IS RE-CHECKED AGAINST THE ALLOWLIST rather than checked for being
 * non-blank, which is `isPermittedAdvertisingLabel`'s own stated job: this
 * reads a value already in the database and asks whether it is one of the
 * strings the validator would have written. The disclosure route will not
 * store a benefit of true without one, so through the API these agree — and
 * this must not assume every row in that table arrived through that route.
 *
 * THE FIRST TWO STATES ARE COLLAPSED — no row, and a row that does not
 * declare a benefit — for the reason `advertisingLabelPublishRefusal` gives
 * for collapsing the same pair: they are one state said two ways, and a
 * reader who checks one and misses the other has written a gate that fails
 * open.
 *
 * `field` NAMES A FIELD OF THE DISCLOSURE ROUTE'S BODY, not of this route's,
 * and deliberately: the caller cannot fix either of these by editing the
 * request they just sent. The fix is a PUT to /api/media/[id]/disclosure, and
 * the field is which part of THAT body to get right.
 */
export function commercialLinkDisclosureRefusal(
  disclosure: AdvertisingDisclosureFacts | null | undefined,
): AdvertisingLabelRefusal | null {
  if (!disclosure || disclosure.benefitReceived !== true) {
    return {
      error:
        "A commercial link is advertising, so this item has to declare the benefit behind it first: record it with PUT /api/media/[id]/disclosure. Forbrukertilsynet requires the page to be labelled at the top as well as at each link (docs/ugc-research.md §3.2).",
      field: "benefitReceived",
    };
  }

  if (!isPermittedAdvertisingLabel(disclosure.label)) {
    return {
      error:
        "This item declares a benefit but carries no permitted advertising label, so a commercial link on it would have nothing labelling the page above it. " +
        `Permitted labels: ${PERMITTED_ADVERTISING_LABELS.join(", ")}.`,
      field: "label",
    };
  }

  return null;
}

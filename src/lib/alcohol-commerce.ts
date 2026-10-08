/**
 * The commercial side of alkoholloven § 9-2 (ugcportal-qnq9.3 K4/K6), in one
 * module with no runtime imports.
 *
 * WHAT THIS IS FOR. src/lib/resale-rights.ts answers "may this upload be
 * SOLD", off the per-upload triage. This answers the two questions that come
 * from the other direction in docs/ugc-research.md §3.1a:
 *
 *   1. WHO IS BEHIND THE BRAND. §3.1a practical rule 1: "Before any paid
 *      deal, check who's behind the brand. If the company also produces,
 *      imports or sells alcohol, decline." Products sharing a brand or a
 *      trademark with an alcoholic drink are inside the ban, so the brand is
 *      refusable on its own, whatever the photograph shows.
 *   2. WHAT THE PICTURE SHOWS, asked again at the moment something COMMERCIAL
 *      is attached to it. The triage fact already stops a sale; this stops a
 *      benefit and a published advertising label, which are a different set
 *      of affordances reached through a different route.
 *
 * NO PRISMA IMPORT, and no import that reaches one — the same claim
 * src/lib/advertising-disclosure.ts makes next door, and the same narrow
 * version of it: these rules are decidable from three nullable booleans, so a
 * test of them should not need a database, even though nothing client-side
 * needs them today.
 *
 * EVERY FUNCTION HERE IS TOTAL OVER `null` AND `undefined`, and that is the
 * whole design. Each of the three inputs has an "unanswered" state that is
 * reachable in production — a listing nobody has triaged, a brand nobody has
 * looked up, a disclosure row that does not exist — and every one of those
 * states has to answer "no" rather than fall through a `=== true` test that
 * was written with only the two interesting values in mind.
 */

/** Why a commercial affordance may not be attached, or published. Shaped like
 * `AdvertisingLabelRefusal` (src/lib/advertising-disclosure.ts) because it is
 * returned from the same two routes and becomes the same `{ error, field }`
 * 400 body. */
export type AlcoholCommerceRefusal = { error: string; field: string };

/** The one BenefitSource column these rules read. A structural type rather
 * than the generated row type, so a caller can hand over a projection of
 * exactly this field and a test can write it out by hand. */
export type BenefitSourceAlcoholFacts = { alcoholLinked: boolean | null };

/** The one MediaListing column these rules read. */
export type ListingAlcoholFacts = { depictsAlcohol: boolean | null };

/**
 * What these rules read about the commercial links attached to one item
 * (ugcportal-6uxv). A COUNT, not the rows: every rule here asks only whether
 * any link is attached, and a projection that handed over URLs and brand ids
 * would invite a caller to decide something else with them in a module whose
 * whole claim is that it decides §9-2 from a handful of nullable scalars.
 *
 * `number` with no "unanswered" state, unlike the two types above, and the
 * difference is real rather than an oversight: a listing or a brand row can
 * be genuinely missing, but "how many commercial links does this item carry"
 * always has an answer, and that answer is zero. A caller that cannot
 * produce the count has not done the read, which is a bug rather than a
 * state to be total over.
 */
export type CommercialLinkFacts = { commercialLinkCount: number };

/**
 * What the record says about alcohol in the picture.
 *
 * THREE VALUES, NOT A BOOLEAN, because the two refusing states are refused by
 * different call sites and one of them is permitted by the write path on
 * purpose (see `benefitAttachmentRefusal`). Collapsing them to "blocked /
 * not blocked" here would push that distinction out to each caller, which is
 * where it would be got wrong.
 *
 * `"absent"` IS RETURNED ONLY FOR A LITERAL `false`. That is what lets a
 * caller write `!== "absent"` and know that a listing that does not exist, a
 * column that is null, and a value that is somehow neither all land on the
 * refusing side — the same reason `isTriaged` in src/lib/resale-rights.ts is
 * a `typeof` check rather than `=== null`.
 */
export type AlcoholDepiction = "depicted" | "unanswered" | "absent";

export function alcoholDepiction(
  listing: ListingAlcoholFacts | null | undefined,
): AlcoholDepiction {
  if (listing?.depictsAlcohol === true) return "depicted";
  if (listing?.depictsAlcohol === false) return "absent";
  return "unanswered";
}

/**
 * K4: whether this brand's recorded answer forbids attaching anything
 * commercial to an item from it.
 *
 * TWO OF THE THREE STATES REFUSE, and the second one is the point of the
 * criterion: "a brand with no recorded answer is treated as unchecked and
 * also refused, so an unasked question never passes as a no". §3.1a says to
 * check who is behind the brand BEFORE the deal, so a brand nobody has
 * checked is not a brand that has passed — and a missing row (`null`, or
 * `undefined` from a select that found nothing) is the commonest way for
 * "nobody asked" to arrive here, which is why it is the default branch rather
 * than a special case.
 *
 * THE MESSAGES DIFFER, and deliberately so, because the operator's next
 * action differs: an alcohol-linked brand means decline the deal, and an
 * unchecked one means go and find out. A single refusal would tell them the
 * deal is off when the answer might be that it is fine.
 */
export function alcoholLinkedBrandRefusal(
  source: BenefitSourceAlcoholFacts | null | undefined,
): AlcoholCommerceRefusal | null {
  if (source?.alcoholLinked === false) return null;

  if (source?.alcoholLinked === true) {
    return {
      error:
        "This brand produces, imports or sells alcohol, or shares a brand with an alcoholic drink, so no benefit, link or advertising label may be attached to anything from it (alkoholloven § 9-2).",
      field: "benefitSource",
    };
  }

  return {
    error:
      "Nobody has recorded whether this brand produces, imports or sells alcohol, or shares a brand with an alcoholic drink. Answer that first: an unasked question is not a no.",
    field: "benefitSource",
  };
}

/**
 * The gate the disclosure write path calls before recording a benefit
 * (ugcportal-qnq9.3 K2's disclosure affordance, and K4's write half).
 *
 * THE ALCOHOL QUESTION IS READ PERMISSIVELY HERE — only a recorded `yes`
 * refuses — and that is the one deliberate asymmetry in this module, so it is
 * worth stating plainly rather than leaving as a reading of `=== "depicted"`.
 *
 * Refusing an UNANSWERED item here would make the advertising label
 * unrecordable on every item until an admin had triaged it, and the label is
 * itself a legal requirement (Forbrukertilsynet, §3.2). The result would be
 * an operator who has received a gift, cannot write it down, and publishes an
 * item that is an undisclosed advertisement — a worse breach reached by being
 * stricter. The honest record comes first; what it may NOT do is become
 * public before the alcohol question is answered, and that is
 * `commercialPublishRefusal`'s job below, which refuses the unanswered state
 * at the one point where the public can see the result.
 *
 * A recorded `yes` is refused here, though, because there is no reading of
 * that in which attaching money is lawful, and the fix is a different
 * photograph rather than a different form field.
 */
export function benefitAttachmentRefusal(item: {
  listing: ListingAlcoholFacts | null | undefined;
  benefitSource: BenefitSourceAlcoholFacts | null | undefined;
}): AlcoholCommerceRefusal | null {
  if (alcoholDepiction(item.listing) === "depicted") {
    return {
      error:
        "This item is recorded as showing alcohol, so no benefit, link or advertising label may be attached to it (alkoholloven § 9-2). Nothing lifts that: §3.1a judges the picture, whatever the glass actually holds.",
      field: "depictsAlcohol",
    };
  }

  return alcoholLinkedBrandRefusal(item.benefitSource);
}

/**
 * The gate the publish route calls (ugcportal-qnq9.3 K6).
 *
 * K6's guardrail is about PUBLISHED rows: this site must never serve a
 * commercial affordance on an image in which alcohol is visible or clearly
 * evoked, or from a brand that also sells alcohol. Publishing is the one
 * chokepoint every public surface is downstream of, so it is where that is
 * enforced.
 *
 * ONLY AN ITEM THAT RECORDS A BENEFIT IS IN SCOPE. An item with no
 * disclosure, or one declaring no benefit, is not advertising for anything
 * and § 9-2 has nothing to say about it — a photograph of a glass of wine is
 * perfectly publishable as personal content, which is the distinction §3.1a
 * practical rule 2 (ugcportal-qnq9.11) is built on. Written as
 * `!== true` rather than `=== false || == null` so a column holding anything
 * else reads as "not a declared benefit", matching
 * `advertisingLabelPublishRefusal`'s own reading of the same field.
 *
 * BOTH REFUSING STATES OF THE ALCOHOL QUESTION ARE REFUSED HERE, unlike at
 * the write — `!== "absent"`. An item nobody has triaged is an item nobody
 * has looked at, and the request being made is to show it to the public with
 * an advertising label on it. There is no honest backfill for the question
 * and no reading under which "we never asked" is a defence; §3.1a's standard
 * is what the picture looks like.
 *
 * THIS IS A BACKSTOP AS WELL AS A GATE. PUT /api/media/[id]/disclosure will
 * not store a benefit against an alcohol-linked or unchecked brand at all, so
 * through the API the brand half of this can only ever agree with what was
 * written. It is re-asked because this is the last thing between a row and a
 * public page, and it must not assume every row in the table was written
 * through that route — the same argument advertising-disclosure.ts gives for
 * re-checking a stored label against the allowlist. The alcohol half is not
 * redundant at all: the write path permits an unanswered item on purpose, so
 * this is the only place that state is refused.
 */
export function commercialPublishRefusal(item: {
  disclosure:
    | {
        benefitReceived: boolean | null;
        benefitSource: BenefitSourceAlcoholFacts | null;
      }
    | null
    | undefined;
  listing: ListingAlcoholFacts | null | undefined;
}): AlcoholCommerceRefusal | null {
  if (item.disclosure?.benefitReceived !== true) return null;

  const brand = alcoholLinkedBrandRefusal(item.disclosure.benefitSource);
  if (brand) return brand;

  if (alcoholDepiction(item.listing) !== "absent") {
    return {
      error:
        "This item records a benefit received, so publishing it publishes an advertisement — and nobody has recorded that it is free of alcohol, or it is recorded as showing some. Answer the alcohol question with a `no` first (alkoholloven § 9-2).",
      field: "depictsAlcohol",
    };
  }

  return null;
}

/**
 * The gate the TRIAGE WRITE path calls before recording an alcohol answer
 * (ugcportal-6uxv K1).
 *
 * THE CONVERSE OF `benefitAttachmentRefusal`, and the reason it has to exist
 * separately. That one asks "may a commercial thing be attached to this
 * picture?" at the moment something commercial arrives, reading the alcohol
 * answer already on the row. This one asks the same legal question from the
 * other end of the clock: the commercial thing is already attached, and it is
 * the ANSWER that is arriving. §9-2 does not care which of the two facts was
 * recorded first — the forbidden state is the pair — so guarding only the
 * order that happened to be implemented first leaves the other order as a
 * two-step route to exactly the row the ban is about.
 *
 * THE INCOMING ANSWER, NOT THE STORED ONE, is what `listing` carries here.
 * The caller passes the value it is about to write, so this decides on the
 * state the transaction would LEAVE BEHIND rather than on the transition. An
 * item already recorded as showing alcohol and already carrying a link is in
 * breach, and re-recording that same answer is refused too: the publish route
 * makes the identical call for the identical reason ("a published row that
 * fails this was written outside this API and IS in breach, and answering 200
 * ... because it already happens to be public is the wrong answer to give").
 * It also means the guard needs no read of the previous answer at all, so
 * there is no stale-read window between deciding and writing.
 *
 * NOT SCOPED TO PUBLISHED ITEMS, although the criterion that asks for it is
 * written about one. Three reasons, in order of weight. A commercial link can
 * only be attached to an item that already declares a benefit under a
 * permitted label (`commercialLinkDisclosureRefusal`), so an unpublished item
 * carrying one is an advertisement one request away from the public rather
 * than a draft. Refusing only the published case would leave unpublish ->
 * reclassify -> publish as a route to the same row, and whether the publish
 * at the end of it refuses depends on `benefitReceived` still being true —
 * which withdrawal clears (ugcportal-jain). And the guardrail enumeration
 * this invariant is measured by already asserts no link sits on an
 * alcohol-recorded row ANYWHERE, published or not
 * (src/lib/alcohol-commerce.guardrail.test.ts, "leaves no price, benefit or
 * link anywhere on an item recorded as showing alcohol").
 *
 * LINKS ONLY, not every commercial affordance. A price and a recorded benefit
 * are reclassifiable-behind in exactly the same way and are NOT guarded here;
 * that is ugcportal-n0vq, filed from this bead, not an oversight. The
 * argument for not folding them in now is that each has a different escape
 * hatch for the admin (unprice, withdraw the disclosure) and so a different
 * message, and this function's input type is the extension point: another
 * fact goes in the parameter object beside `commercialLinks`.
 */
export function alcoholReclassificationRefusal(item: {
  /** The answer about to be written, not the one currently stored. */
  listing: ListingAlcoholFacts | null | undefined;
  commercialLinks: CommercialLinkFacts;
}): AlcoholCommerceRefusal | null {
  // `=== "depicted"` and not `!== "absent"`, matching the WRITE-side reading
  // in `benefitAttachmentRefusal` rather than the publish-side one. Only a
  // recorded `yes` creates the forbidden pair; an answer being cleared back
  // to "nobody has looked" leaves an item that cannot be published while a
  // benefit stands (`commercialPublishRefusal` refuses the unanswered state
  // at the public boundary), and refusing it here would mean an admin who
  // mis-clicked `yes` could not take it back without first dismantling the
  // item's links.
  if (alcoholDepiction(item.listing) !== "depicted") return null;
  if (item.commercialLinks.commercialLinkCount < 1) return null;

  return {
    error:
      "This item already carries a commercial link, and nothing commercial may sit on a picture showing alcohol (alkoholloven § 9-2). Detach every commercial link on it first, then record the alcohol answer — recording it now would leave a live advertising link under a photograph of a drink.",
    field: "depictsAlcohol",
  };
}

/**
 * The brand answer that stands, given what is already recorded and what a
 * request submitted.
 *
 * MONOTONE TOWARDS `true`, WHICH IS THE WHOLE RULE. A recorded `yes` can
 * never be talked back down to a `no`, and a submitted `yes` wins over a
 * recorded `no`. Without that, the check is bypassable by resubmitting: the
 * only person who ever answers this question is the person who wants the deal
 * to go through, so "this brand is alcohol-linked" has to be a one-way door
 * in exactly the way ALCOHOL's `settledBy: "nothing"` is one upload over.
 *
 * `undefined` for "the request did not answer", distinct from `null` for "the
 * request withdrew the answer" — which it may not do, so `null` is not
 * accepted by the caller that validates the field. Only an unanswered brand
 * can be answered at all; see the caller's own comment for why the one write
 * this ever produces is `null` -> `false`.
 */
export function effectiveBrandAlcoholAnswer(
  recorded: boolean | null,
  submitted: boolean | undefined,
): boolean | null {
  if (recorded === true || submitted === true) return true;
  return submitted ?? recorded;
}

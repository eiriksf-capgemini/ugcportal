import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TRIAGE_ANSWER_NO,
  TRIAGE_ANSWER_YES,
  type TriageAnswers,
} from "@/lib/curation-triage";
import { TRIAGE_FACTS } from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * ugcportal-6uxv K1: an item that already carries a commercial link may not
 * be reclassified as showing alcohol.
 *
 * THE SEQUENCE THE CRITERION NAMES — attach, publish, reclassify — driven
 * through the real write paths at every step: the real disclosure route (a
 * link may only be attached to an item that declares a benefit under a
 * permitted label), the real attach route, the real publish route and the
 * real server action, in that order — with one clean triage in between,
 * because an item that records a benefit cannot be published until the
 * alcohol question is answered `no` (see `buildItem`). No `CommercialLink`
 * row and no triage answer is written by hand anywhere below, because the
 * claim is about what the product lets through and a hand-seeded fixture
 * would only be a claim about this file. The single exception is the
 * `already-in-breach` case, which edits one column directly and says why: no
 * route will produce that row, which is the whole reason it is interesting.
 *
 * WHAT MAKES THE REFUSAL ASSERTION MEAN ANYTHING. "The write was refused"
 * passes just as well against a write path that is simply broken, and the
 * refusal would be indistinguishable from a 500 the suite swallowed. So
 * every refusing case here is paired with a CONTROL that differs in exactly
 * one input and must SUCCEED:
 *
 *   (a) the same item, the same call, with no commercial link attached;
 *   (b) the same item, the same link, with `depictsAlcohol` answered `no`.
 *
 * Both are asserted as recorded writes with their columns read back. Without
 * them, nothing here distinguishes this guard from a triage screen that
 * records nothing at all.
 */

const authMock = vi.fn();
vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

const redirectMock = vi.fn();
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { recordTriage } = await import("@/app/admin/curation/actions");
const { PUT: DISCLOSE } = await import("@/app/api/media/[id]/disclosure/route");
const { POST: PUBLISH } = await import("@/app/api/media/[id]/publish/route");
const { POST: ATTACH_LINK, DELETE: DETACH_LINK } = await import(
  "@/app/api/media/[id]/commercial-links/route"
);

/**
 * One account that is both the owner of every item and the admin who triages
 * it — the same choice `alcohol-commerce.guardrail.test.ts` makes, and for
 * the same reason: with one account, no case here can pass because a second
 * account happened to lack a permission.
 */
const OPERATOR = "operator-6uxv";
const SESSION = {
  user: { id: OPERATOR, email: "operator@example.com", role: "ADMIN" },
};

const FIELDS = TRIAGE_FACTS.map((fact) => fact.field);

/** The brand both the disclosure and the link point at: recorded, and
 * recorded as not alcohol-linked, so no refusal anywhere below is ever about
 * the brand rather than about the picture. */
const BRAND = "Riedel";

/**
 * Every registered fact answered `false`.
 *
 * `false` and not a mixed set, because the single variable these cases turn
 * on is `depictsAlcohol`: a mixed baseline would mean the refusing call and
 * its control differed in whatever else the alternation happened to assign.
 */
const ALL_NO: TriageAnswers = Object.fromEntries(
  FIELDS.map((field) => [field, false]),
) as TriageAnswers;

/** The same answers with the alcohol question answered `yes` — the one
 * difference between the refused call and its control. */
const ALCOHOL_YES: TriageAnswers = { ...ALL_NO, depictsAlcohol: true };

function triageForm(mediaId: string, answers: TriageAnswers): FormData {
  const data = new FormData();
  data.set("mediaId", mediaId);
  for (const [field, answer] of Object.entries(answers)) {
    data.set(field, answer ? TRIAGE_ANSWER_YES : TRIAGE_ANSWER_NO);
  }
  return data;
}

const context = (id: string) => ({ params: Promise.resolve({ id }) });

function disclosureRequest(id: string) {
  return new Request(`http://localhost/api/media/${id}/disclosure`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      benefitReceived: true,
      benefitKind: "FREE_PRODUCT",
      benefitSource: BRAND,
      marketValueOre: 49900,
      label: "Advertisement / Reklame",
    }),
  });
}

function attachRequest(id: string) {
  return new Request(`http://localhost/api/media/${id}/commercial-links`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      url: `https://track.adtraction.com/t/t?a=1234&m=${id}`,
      network: "ADTRACTION",
      benefitSource: BRAND,
    }),
  });
}

function detachRequest(id: string, linkId: string) {
  return new Request(
    `http://localhost/api/media/${id}/commercial-links?linkId=${linkId}`,
    { method: "DELETE" },
  );
}

function publishRequest(id: string) {
  return new Request(`http://localhost/api/media/${id}/publish`, {
    method: "POST",
  });
}

/** The single `?error=` code the action last redirected with, or null. */
function redirectedError(): string | null {
  const target = redirectMock.mock.calls.at(-1)?.[0];
  if (typeof target !== "string") return null;
  return new URL(target, "http://localhost").searchParams.get("error");
}

/**
 * Build one item up to the state a case needs, through the real routes, and
 * assert each step actually worked.
 *
 * The assertions inside the builder are the thing that keeps the cases below
 * honest: if the attach silently 400s, every "the link is still there"
 * assertion downstream would be vacuously about an item that never had one,
 * and the refusal under test would be firing against an empty collection.
 */
async function buildItem(
  id: string,
  options: { link: boolean; publish: boolean },
): Promise<{ linkId: string | null }> {
  await prisma.media.create({
    data: {
      id,
      userId: OPERATOR,
      kind: "IMAGE",
      key: `media/${OPERATOR}/${id}.png`,
      previewKey: `previews/${OPERATOR}/${id}.webp`,
      previewId: `preview-${id}`,
      mimeType: "image/png",
      sizeBytes: 1024,
      originalName: `${id}.png`,
      altText: "A glass on a table",
    },
  });

  // Always, link or no link: the disclosure is what the attach route demands,
  // and leaving it off the no-link item would make the two differ in two
  // things rather than one.
  const disclosed = await DISCLOSE(disclosureRequest(id), context(id));
  expect(disclosed.status, `${id}: disclosure`).toBe(200);

  let linkId: string | null = null;
  if (options.link) {
    const attached = await ATTACH_LINK(attachRequest(id), context(id));
    expect(attached.status, `${id}: attach`).toBe(201);
    linkId = ((await attached.json()) as { id: string }).id;
  }

  if (options.publish) {
    // A CLEAN TRIAGE FIRST, through the same action the cases below call.
    // This is not scaffolding: an item that records a benefit cannot be
    // published until the alcohol question is answered `no`
    // (`commercialPublishRefusal` refuses the unanswered state as well as the
    // depicted one), so "attach, publish, reclassify" is really "attach,
    // answer no, publish, answer yes" — and discovering that the publish was
    // refused for an unrelated reason is exactly what the status assertions
    // in this builder are here to prevent.
    await recordTriage(triageForm(id, ALL_NO));
    expect(redirectedError(), `${id}: clean triage`).toBeNull();

    const published = await PUBLISH(publishRequest(id), context(id));
    expect(published.status, `${id}: publish`).toBe(200);
  }

  return { linkId };
}

async function listingFor(mediaId: string) {
  return prisma.mediaListing.findUnique({ where: { mediaId } });
}

async function linkCount(mediaId: string) {
  return prisma.commercialLink.count({ where: { mediaId } });
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: OPERATOR, email: "operator@example.com", role: "ADMIN" },
  });
  await prisma.benefitSource.create({
    data: {
      slug: BRAND.toLowerCase(),
      name: BRAND,
      alcoholLinked: false,
      alcoholAnsweredAt: new Date(),
    },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(() => {
  authMock.mockReset().mockResolvedValue(SESSION);
  revalidatePathMock.mockReset();
  redirectMock.mockReset();
});

describe("ugcportal-6uxv K1: attach, publish, then reclassify as alcohol", () => {
  it("refuses the reclassification, and the same call succeeds once the link is detached", async () => {
    const id = "attached-published";
    const { linkId } = await buildItem(id, { link: true, publish: true });

    // THE SEQUENCE. The item is public and carries a live commercial link;
    // the admin now answers `yes` to the alcohol question.
    await recordTriage(triageForm(id, ALCOHOL_YES));

    expect(redirectedError()).toBe("alcohol_with_commercial_links");
    // The answer did not land. The clean triage the publish required is
    // still what the row says; "leaves an already-recorded triage exactly as
    // it was" below makes the stronger column-for-column version of this.
    expect((await listingFor(id))?.depictsAlcohol).toBe(false);
    // And nothing was destroyed either — this is the REFUSE branch, not the
    // detach-and-unpublish one, so the link and the publication both stand
    // and the admin can resolve the conflict whichever way they meant to.
    expect(await linkCount(id)).toBe(1);
    expect(
      (await prisma.media.findUniqueOrThrow({ where: { id } })).publishedAt,
    ).not.toBeNull();

    /*
      CONTROL (a), and the whole reason the assertion above is evidence of
      anything: the SAME action, the SAME form, the SAME item, with one
      input changed — the link is gone. If this did not record, the refusal
      above would be indistinguishable from a triage write that never works.
    */
    if (linkId === null) throw new Error("fixture: no link to detach");
    const detached = await DETACH_LINK(detachRequest(id, linkId), context(id));
    expect(detached.status).toBe(204);
    expect(await linkCount(id)).toBe(0);

    await recordTriage(triageForm(id, ALCOHOL_YES));
    expect(redirectedError()).toBeNull();
    const listing = await listingFor(id);
    expect(listing?.depictsAlcohol).toBe(true);
    expect(listing?.triagedByUserId).toBe(OPERATOR);
  });

  it("records the very same triage with the link still attached when the answer is `no`", async () => {
    /*
      CONTROL (b): the item keeps its commercial link and stays published,
      and only the alcohol answer differs. This is what connects the refusal
      to the ALCOHOL half of the pair rather than to the mere presence of a
      link — without it, a guard that refused every triage of a linked item
      would pass the case above.
    */
    const id = "attached-published-answered-no";
    await buildItem(id, { link: true, publish: true });

    await recordTriage(triageForm(id, ALL_NO));

    expect(redirectedError()).toBeNull();
    const listing = await listingFor(id);
    expect(listing).not.toBeNull();
    for (const field of FIELDS) {
      expect(listing?.[field], field).toBe(false);
    }
    expect(await linkCount(id)).toBe(1);
  });

  it("leaves an already-recorded triage exactly as it was", async () => {
    // The refusal must not be a partial write. The item is triaged clean
    // first — which the case above establishes is allowed — and then the
    // refused call must change nothing at all, not the alcohol column and
    // not the attribution.
    const id = "already-triaged";
    await buildItem(id, { link: true, publish: true });

    await recordTriage(triageForm(id, ALL_NO));
    const before = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: id },
    });

    await recordTriage(triageForm(id, ALCOHOL_YES));
    expect(redirectedError()).toBe("alcohol_with_commercial_links");

    const after = await prisma.mediaListing.findUniqueOrThrow({
      where: { mediaId: id },
    });
    // Column for column, by value, so a change to anything on the row fails
    // here rather than only the three columns someone thought to name.
    expect(
      Object.fromEntries(
        Object.entries(after).map(([key, value]) => [key, String(value)]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(before).map(([key, value]) => [key, String(value)]),
      ),
    );
  });

  it("refuses an UNPUBLISHED item with a link too, so unpublish-reclassify-publish is not a route in", async () => {
    // Deliberately wider than the criterion, which is written about a
    // published item. A link can only be attached to an item that already
    // declares a benefit under a permitted label, so an unpublished item
    // carrying one is an advertisement one request away from the public —
    // and refusing only the published case would leave the three-step
    // sequence in this test's name as a way to reach exactly the row § 9-2
    // bans.
    const id = "attached-unpublished";
    await buildItem(id, { link: true, publish: false });
    expect(
      (await prisma.media.findUniqueOrThrow({ where: { id } })).publishedAt,
    ).toBeNull();

    await recordTriage(triageForm(id, ALCOHOL_YES));

    expect(redirectedError()).toBe("alcohol_with_commercial_links");
    expect(await listingFor(id)).toBeNull();
  });

  it("refuses re-recording the same answer on a row that is already in breach", async () => {
    // The guard decides on the state the transaction would LEAVE BEHIND, not
    // on the transition, so an item that somehow already holds the forbidden
    // pair is not quietly re-blessed by a second submit. The breach is
    // created by hand here precisely because no route will produce it —
    // which is the point: this is the row written outside the API that the
    // publish route's own docstring refuses to answer 200 to.
    const id = "already-in-breach";
    await buildItem(id, { link: true, publish: true });
    await prisma.mediaListing.update({
      where: { mediaId: id },
      data: { depictsAlcohol: true },
    });

    await recordTriage(triageForm(id, ALCOHOL_YES));

    expect(redirectedError()).toBe("alcohol_with_commercial_links");
    expect((await listingFor(id))?.depictsAlcohol).toBe(true);
    expect(await linkCount(id)).toBe(1);
  });

  it("records a clean item with no link and no disclosure, so the guard is not refusing everything", async () => {
    // The outermost control: an ordinary item, nothing commercial anywhere
    // near it, triaged as showing alcohol. This is the lawful case — a
    // photograph of a glass of wine is perfectly publishable as personal
    // content — and it must still record.
    const id = "plain-alcohol-photo";
    await prisma.media.create({
      data: {
        id,
        userId: OPERATOR,
        kind: "IMAGE",
        key: `media/${OPERATOR}/${id}.png`,
        previewKey: `previews/${OPERATOR}/${id}.webp`,
        previewId: `preview-${id}`,
        mimeType: "image/png",
        sizeBytes: 1024,
        originalName: `${id}.png`,
        altText: "A glass of wine",
      },
    });

    await recordTriage(triageForm(id, ALCOHOL_YES));

    expect(redirectedError()).toBeNull();
    expect((await listingFor(id))?.depictsAlcohol).toBe(true);
  });
});

describe("ugcportal-6uxv K2: the forbidden pair is absent from the whole table", () => {
  it("holds no row carrying both depictsAlcohol true and a commercial link", async () => {
    /*
      The same shape as the guardrail enumeration in
      src/lib/alcohol-commerce.guardrail.test.ts ("leaves no price, benefit or
      link anywhere on an item recorded as showing alcohol"), asked over the
      database THIS file built through the triage write path — which that file
      never calls. It is not a second copy of that assertion for its own sake:
      the enumeration over there can only ever see rows the routes it drives
      produced, so the reclassification order is invisible to it.

      `already-in-breach` is excluded by id and by nothing else, because this
      file seeds that one row by hand on purpose. Excluding it by a predicate
      ("rows a route wrote") would be a filter that could silently grow.
    */
    const offenders = await prisma.media.findMany({
      where: {
        listing: { depictsAlcohol: true },
        commercialLinks: { some: {} },
        id: { not: "already-in-breach" },
      },
      select: { id: true },
    });

    expect(offenders.map((row) => row.id)).toEqual([]);
  });

  it("holds rows that would appear above if the guard were removed", async () => {
    // The sweep's own non-vacuity check: the items it is scanning really do
    // exist, really do carry links, and really were put through a `yes`
    // answer that was refused — so the empty result above is a measurement
    // rather than a statement about an empty table.
    const linked = await prisma.media.findMany({
      where: { commercialLinks: { some: {} } },
      select: { id: true, listing: { select: { depictsAlcohol: true } } },
      orderBy: { id: "asc" },
    });

    expect(linked.map((row) => row.id)).toEqual([
      "already-in-breach",
      "already-triaged",
      "attached-published-answered-no",
      "attached-unpublished",
    ]);
    // `attached-published` is absent: its link was detached by control (a).
    // The three that a route wrote a triage for all read `false`, and the
    // one that reads `true` is the hand-seeded breach.
    expect(
      linked
        .filter((row) => row.id !== "already-in-breach")
        .map((row) => row.listing?.depictsAlcohol ?? null),
    ).toEqual([false, false, null]);
  });
});

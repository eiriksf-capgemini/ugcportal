import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  ACCEPTED_CHECKLIST_VERSIONS,
  CURRENT_CHECKLIST_VERSION,
  uploaderClearanceBlocker,
} from "@/lib/resale-rights";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The full loop, against a real database: render the decision form for an
 * existing clearance, turn the rendered markup into the FormData a browser
 * would actually submit, change one unrelated field, and post it through the
 * real route handler.
 *
 * This is the regression test for the one fail-OPEN path this feature had:
 * `validUntil` rendered without its current value, so editing the conditions
 * text silently turned a time-limited clearance into a perpetual one. Testing
 * it end to end rather than at the component alone is the point — the bug
 * lived in the seam between what the page rendered and what the handler wrote,
 * and neither half was wrong on its own.
 */

const authMock = vi.fn();

vi.mock("@/lib/auth", () => ({ auth: authMock, getSession: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { POST: recordDecision } = await import(
  "@/app/api/admin/rights/decision/route"
);
const { ResaleRightsDecisionForm } = await import(
  "@/app/admin/settings/rights/decision-form"
);
const { setResaleRightsStatus } = await import("@/lib/resale-rights-review");

const DECISION_URL = "http://localhost/api/admin/rights/decision";
const UPLOADER = "uploader-1";

/**
 * Submits the form the way a browser would: a multipart POST to the route
 * handler, with the Origin header a real form post carries.
 */
async function submit(form: FormData): Promise<Response> {
  return recordDecision(
    new Request(DECISION_URL, {
      method: "POST",
      body: form,
      headers: { origin: "http://localhost" },
    }),
  );
}

/** Asserts a 303 back to the settings page carrying `query`. */
async function expectRedirect(form: FormData, query: string): Promise<void> {
  const response = await submit(form);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toContain(query);
}

const ADMIN = { user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" } };
const VALID_UNTIL = new Date("2027-06-01T00:00:00.000Z");
/** A version the checklist has moved on from, so the gate no longer accepts it. */
const RETIRED_VERSION = "2019-01-01.0";

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/**
 * What a browser would submit for this form, read out of the rendered HTML:
 * every named input's value, the selected option of every select, and the
 * body of every textarea. File inputs are skipped — an empty file picker
 * sends an empty file, which the handler ignores.
 *
 * Deliberately parsed from the markup rather than rebuilt from the props: a
 * field the server never rendered is exactly the bug under test, and a
 * hand-built FormData would paper straight over it.
 */
function formDataFromMarkup(markup: string): FormData {
  const data = new FormData();

  for (const [tag] of markup.matchAll(/<input\b[^>]*>/g)) {
    const name = attribute(tag, "name");
    const type = attribute(tag, "type");
    if (!name || type === "file") continue;
    // A browser submits a checkbox only when it is checked, and submits
    // nothing at all for it otherwise — which is what makes "unticked" mean
    // "leave the checklist version alone". Getting this wrong in the harness
    // would have hidden the very bug these tests cover.
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/.test(tag)) {
      continue;
    }
    data.set(name, decodeEntities(attribute(tag, "value") ?? ""));
  }

  for (const match of markup.matchAll(
    /<select\b([^>]*)>([\s\S]*?)<\/select>/g,
  )) {
    const name = attribute(match[1], "name");
    if (!name) continue;
    const options = [...match[2].matchAll(/<option\b([^>]*)>/g)].map(
      (option) => option[1],
    );
    const chosen =
      options.find((option) => /\bselected\b/.test(option)) ?? options[0] ?? "";
    data.set(name, decodeEntities(attribute(chosen, "value") ?? ""));
  }

  for (const match of markup.matchAll(
    /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g,
  )) {
    const name = attribute(match[1], "name");
    if (!name) continue;
    data.set(name, decodeEntities(match[2]));
  }

  return data;
}

/** Renders the form exactly as page.tsx does, from the stored review. */
async function renderFormForUploader(): Promise<FormData> {
  const review = await prisma.resaleRightsReview.findUnique({
    where: { uploaderUserId: UPLOADER },
    select: {
      status: true,
      route: true,
      validUntil: true,
      conditions: true,
      checklistVersion: true,
      // ugcportal-aqw. page.tsx's own UPLOADER_SELECT names these two, so
      // this harness has to as well — otherwise the form under test would
      // render "no scope recorded" for a clearance that has one, and the
      // round-trip would be exercising a shape the real page never sends.
      coversUploadsBefore: true,
      coversFutureUploads: true,
    },
  });

  const markup = renderToStaticMarkup(
    <ResaleRightsDecisionForm
      uploaderUserId={UPLOADER}
      review={review}
      action="/api/admin/rights/decision"
    />,
  );
  return formDataFromMarkup(markup);
}

async function storedReview() {
  return prisma.resaleRightsReview.findUniqueOrThrow({
    where: { uploaderUserId: UPLOADER },
  });
}

/** The uploader-level blocker for the stored row, as the page computes it. */
async function blockerForStoredReview() {
  const review = await storedReview();
  return uploaderClearanceBlocker({
    status: review.status,
    checklistVersion: review.checklistVersion,
    reviewedByUserId: review.reviewedByUserId,
    validUntil: review.validUntil,
    coversUploadsBefore: review.coversUploadsBefore,
    coversFutureUploads: review.coversFutureUploads,
    reviewedBy: { role: "ADMIN" },
  });
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
  });
  await prisma.user.create({
    data: { id: UPLOADER, email: "uploader@example.com", role: "USER" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  authMock.mockReset().mockResolvedValue(ADMIN);
  await prisma.resaleRightsEvent.deleteMany({});
  await prisma.resaleRightsReview.deleteMany({});
  // A time-limited clearance, as an admin would have recorded it.
  await setResaleRightsStatus(UPLOADER, {
    source: "ADMIN",
    actorUserId: "admin-1",
    actorEmail: "admin@example.com",
    status: "CLEARED",
    reason: "Signed assignment, expires with the contract.",
    route: "CONTRACT",
    validUntil: VALID_UNTIL,
    conditions: "Editorial use only.",
  });
});

describe("the whole row round-trips", () => {
  /**
   * The generalised version of the fail-opens found in review, and the
   * reason this is a loop rather than a list of fields: all of them were "a
   * form field that does not round-trip its stored value", and a per-field
   * assertion only catches the fields someone thought to name. This walks
   * every column of the stored review, so a field added later is covered
   * the day it exists — including one added by a different bead.
   */
  it("changes nothing but the reviewer stamp when only the reason is edited", async () => {
    // Populate every writable column first, so nothing is trivially null.
    await setResaleRightsStatus(UPLOADER, {
      source: "ADMIN",
      actorUserId: "admin-1",
      actorEmail: "admin@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file.",
      route: "CONTRACT",
      validUntil: VALID_UNTIL,
      conditions: "Editorial use only.",
      evidence: {
        key: "rights-evidence/uploader-1/contract.pdf",
        sha256: "abc123",
      },
      restampChecklist: true,
    });

    const before = await storedReview();

    const form = await renderFormForUploader();
    form.set("reason", "Filing the same decision again, with a clearer note.");
    await expectRedirect(form, "rights=recorded");

    const after = await storedReview();

    // The only columns allowed to move: who decided and when, which is the
    // whole point of recording a decision, and Prisma's own bookkeeping.
    const expectedToChange = new Set(["reviewedAt", "updatedAt"]);
    for (const key of Object.keys(before) as (keyof typeof before)[]) {
      if (expectedToChange.has(key)) continue;
      // Keyed so a failure names the offending column rather than dumping
      // the whole row.
      expect({ [key]: after[key] }).toEqual({ [key]: before[key] });
    }

    // And the stamp really did move, so the loop above is not vacuous.
    expect(after.reviewedAt!.getTime()).toBeGreaterThanOrEqual(
      before.reviewedAt!.getTime(),
    );
    expect(after.reviewedByUserId).toBe("admin-1");
  });

  /**
   * ugcportal-vsm: the anchor is not a form field, and the round-trip has to
   * say so. `uploaderUserId` is rendered as a hidden input carrying the
   * uploader the page opened the form for — it identifies the record rather
   * than being a value the reviewer edits, and a POST naming a different
   * uploader writes a different row rather than re-pointing this one.
   */
  it("writes the uploader the form was rendered for, and no other", async () => {
    await prisma.user.create({
      data: { id: "uploader-2", email: "second@example.com", role: "USER" },
    });

    const form = await renderFormForUploader();
    expect(form.get("uploaderUserId")).toBe(UPLOADER);
    form.set("uploaderUserId", "uploader-2");
    form.set("status", "CLEARED");
    form.set("reason", "A decision about a different person entirely.");
    await expectRedirect(form, "rights=recorded");

    // The first uploader's clearance is untouched...
    expect((await storedReview()).status).toBe("CLEARED");
    // ...and the second got their own row rather than inheriting one.
    const second = await prisma.resaleRightsReview.findUniqueOrThrow({
      where: { uploaderUserId: "uploader-2" },
    });
    expect(second.id).not.toBe((await storedReview()).id);

    await prisma.user.delete({ where: { id: "uploader-2" } });
  });
});

describe("editing one field does not silently change the others", () => {
  it("keeps validUntil when an admin only edits the conditions", async () => {
    const form = await renderFormForUploader();
    // Exactly what the reviewer does: retype the conditions, state a reason,
    // submit. Nothing else is touched.
    form.set("conditions", "Editorial use only. No political advertising.");
    form.set("reason", "Uploader clarified the permitted uses.");

    await expectRedirect(form, "rights=recorded");

    const review = await storedReview();
    expect(review.validUntil?.toISOString()).toBe(VALID_UNTIL.toISOString());
    expect(review.status).toBe("CLEARED");
    expect(review.route).toBe("CONTRACT");
    expect(review.conditions).toBe(
      "Editorial use only. No political advertising.",
    );
  });

  it("keeps validUntil across a status change too", async () => {
    const form = await renderFormForUploader();
    form.set("status", "IN_REVIEW");
    form.set("reason", "Re-checking the music layer.");

    await expectRedirect(form, "rights=recorded");

    const review = await storedReview();
    expect(review.status).toBe("IN_REVIEW");
    expect(review.validUntil?.toISOString()).toBe(VALID_UNTIL.toISOString());
  });

  // The other half of the contract: clearing the field really does clear it,
  // so an admin can still remove an expiry on purpose. This is also why the
  // rendered defaultValue is load-bearing rather than cosmetic — with the
  // field blank, every edit would take this branch.
  it("still lets an admin remove the expiry deliberately", async () => {
    const form = await renderFormForUploader();
    form.set("validUntil", "");
    form.set("reason", "Contract renewed with no end date.");

    await expectRedirect(form, "rights=recorded");

    expect((await storedReview()).validUntil).toBeNull();
  });

  // Same bug, different field. `checklistVersion` decides *which* checklist
  // a clearance was granted under, and dropping a version from
  // ACCEPTED_CHECKLIST_VERSIONS is how a revision to the legal process
  // forces every uploader to be re-reviewed. Re-stamping it on any edit
  // quietly undoes that.
  it("keeps a retired checklistVersion when an admin only edits the conditions", async () => {
    // The uploader was cleared, then the checklist was revised and the
    // version they were cleared under retired.
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: UPLOADER },
      data: { checklistVersion: RETIRED_VERSION },
    });
    expect(ACCEPTED_CHECKLIST_VERSIONS.has(RETIRED_VERSION)).toBe(false);

    const form = await renderFormForUploader();
    form.set("conditions", "Editorial use only. No political advertising.");
    form.set("reason", "Uploader clarified the permitted uses.");

    await expectRedirect(form, "rights=recorded");

    expect((await storedReview()).checklistVersion).toBe(RETIRED_VERSION);
    // And nothing of theirs is sellable, which is the point of retiring a
    // version in the first place.
    expect(await blockerForStoredReview()).toBe("checklist_version_retired");
  });

  it("re-stamps only when the reviewer says they re-ran the checklist", async () => {
    await prisma.resaleRightsReview.update({
      where: { uploaderUserId: UPLOADER },
      data: { checklistVersion: RETIRED_VERSION },
    });

    const form = await renderFormForUploader();
    form.set("reason", "Re-reviewed against the new checklist; still clear.");
    // What ticking the checkbox submits.
    form.set("restampChecklist", "yes");

    await expectRedirect(form, "rights=recorded");

    expect((await storedReview()).checklistVersion).toBe(
      CURRENT_CHECKLIST_VERSION,
    );
    expect(await blockerForStoredReview()).toBeNull();
  });

  it("carries the rendered expiry through as the same instant", async () => {
    // Guards the format seam: the form writes YYYY-MM-DD, the handler parses
    // it back. A local-time formatter on either side moves the expiry a day.
    const form = await renderFormForUploader();
    expect(form.get("validUntil")).toBe("2027-06-01");
    form.set("reason", "No change.");

    await expectRedirect(form, "rights=recorded");

    expect((await storedReview()).validUntil?.toISOString()).toBe(
      "2027-06-01T00:00:00.000Z",
    );
  });

  /**
   * The handler must not depend on its own UI being the only caller. A POST
   * that simply omits an optional field — a partial request, a future form
   * that drops it — leaves the stored value alone; only an explicit blank
   * clears it.
   */
  it("leaves every optional field alone on a POST that omits them", async () => {
    const form = new FormData();
    form.set("uploaderUserId", UPLOADER);
    form.set("status", "CLEARED");
    form.set("reason", "A partial POST that is not this form.");

    await expectRedirect(form, "rights=recorded");

    const review = await storedReview();
    expect(review.validUntil?.toISOString()).toBe(VALID_UNTIL.toISOString());
    expect(review.route).toBe("CONTRACT");
    expect(review.conditions).toBe("Editorial use only.");
  });

  /**
   * ugcportal-aqw K2, through the real form and the real handler.
   *
   * The scope is the one pair of fields that must NOT round-trip the way
   * `validUntil` does. The date input is day-granular while the stored
   * cut-off is an instant, so a value written back on every submit would
   * silently move a mid-afternoon cut-off to that morning's midnight. The
   * handler therefore reads it only behind the `setScope` checkbox, and the
   * three cases below are the three ways that can be got wrong: the field
   * present but ungated, the field absent entirely, and the gate itself not
   * working.
   */
  it("keeps the recorded scope when an admin only edits the conditions", async () => {
    const before = await storedReview();
    // The seed cleared this uploader, so a scope exists to preserve —
    // without this the assertion below could pass on two nulls.
    expect(before.coversUploadsBefore).toBeInstanceOf(Date);

    const form = await renderFormForUploader();
    // The form really does render the field, and really does render it
    // with the stored day — so the preservation below is the handler's
    // gate doing its job, not the value being missing from the POST.
    expect(form.get("coversUploadsBefore")).toBe(
      before.coversUploadsBefore!.toISOString().slice(0, 10),
    );
    expect(form.get("setScope")).toBeNull();

    form.set("conditions", "Editorial use only. No political advertising.");
    form.set("reason", "Uploader clarified the permitted uses.");
    await expectRedirect(form, "rights=recorded");

    const after = await storedReview();
    expect(after.coversUploadsBefore?.toISOString()).toBe(
      before.coversUploadsBefore!.toISOString(),
    );
    expect(after.coversFutureUploads).toBe(false);
    expect(after.conditions).toBe(
      "Editorial use only. No political advertising.",
    );
  });

  it("keeps the recorded scope when the POST omits the field entirely", async () => {
    const before = await storedReview();
    expect(before.coversUploadsBefore).toBeInstanceOf(Date);

    const form = await renderFormForUploader();
    // The fixture mutation the bead asks for: a POST with no scope field at
    // all — a partial request, or a future form that drops it.
    form.delete("coversUploadsBefore");
    form.delete("coversFutureUploads");
    form.set("reason", "A submit from a form that never had those fields.");
    await expectRedirect(form, "rights=recorded");

    expect((await storedReview()).coversUploadsBefore?.toISOString()).toBe(
      before.coversUploadsBefore!.toISOString(),
    );
  });

  it("records a new scope only when the reviewer ticks the control", async () => {
    const before = await storedReview();

    const form = await renderFormForUploader();
    form.set("coversUploadsBefore", "2026-02-03");
    form.set("reason", "Narrowing the scope to the listed works.");
    // Ungated first: the same POST, without the tick, must change nothing.
    await expectRedirect(form, "rights=recorded");
    expect((await storedReview()).coversUploadsBefore?.toISOString()).toBe(
      before.coversUploadsBefore!.toISOString(),
    );

    // What ticking the checkbox submits.
    form.set("setScope", "yes");
    await expectRedirect(form, "rights=recorded");
    expect((await storedReview()).coversUploadsBefore?.toISOString()).toBe(
      "2026-02-03T00:00:00.000Z",
    );
  });

  it("records a framework licence only behind the same control", async () => {
    const form = await renderFormForUploader();
    // What ticking the framework-licence checkbox submits, without the
    // scope control: the clearance must not start covering future uploads.
    form.set("coversFutureUploads", "yes");
    form.set("reason", "Ticked the wrong box and submitted.");
    await expectRedirect(form, "rights=recorded");
    expect((await storedReview()).coversFutureUploads).toBe(false);

    form.set("setScope", "yes");
    form.set("reason", "The instrument is a framework licence; recorded.");
    await expectRedirect(form, "rights=recorded");
    expect((await storedReview()).coversFutureUploads).toBe(true);
  });

  it("refuses a scope cut-off it cannot read, and writes nothing", async () => {
    const before = await storedReview();

    const form = await renderFormForUploader();
    form.set("setScope", "yes");
    form.set("coversUploadsBefore", "the third of never");
    form.set("reason", "Typed the date by hand.");

    await expectRedirect(form, "error=rights_invalid_covers_uploads_before");

    const after = await storedReview();
    expect(after.coversUploadsBefore?.toISOString()).toBe(
      before.coversUploadsBefore!.toISOString(),
    );
    // Nothing else landed either: the handler returns before the writer.
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });
});

describe("the audit trail outlives the uploader", () => {
  /**
   * ugcportal-0ss protected this against one click of Disconnect. The
   * re-anchoring moves the trigger — deleting a user now cascades the review
   * away — so the same property is asserted against the new anchor rather
   * than assumed to have survived the move.
   */
  it("keeps every event when the uploader's account is deleted", async () => {
    const before = await prisma.resaleRightsEvent.findMany({
      where: { subjectId: UPLOADER },
    });
    expect(before.length).toBeGreaterThan(0);

    await prisma.user.delete({ where: { id: UPLOADER } });

    // Cascades with the user, as intended: this is current state.
    expect(
      await prisma.resaleRightsReview.findUnique({
        where: { uploaderUserId: UPLOADER },
      }),
    ).toBeNull();

    const after = await prisma.resaleRightsEvent.findMany({
      where: { subjectId: UPLOADER },
    });
    expect(after).toHaveLength(before.length);
    expect(after.at(-1)).toMatchObject({
      subjectKind: "UPLOADER",
      subjectLabel: "uploader@example.com",
      toStatus: "CLEARED",
      actorUserId: "admin-1",
    });

    // Restore for whatever runs next; beforeEach only rebuilds the review.
    await prisma.user.create({
      data: { id: UPLOADER, email: "uploader@example.com", role: "USER" },
    });
  });
});

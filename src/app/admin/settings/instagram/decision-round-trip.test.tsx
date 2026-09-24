import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
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
  accountClearanceBlocker,
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

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { POST: recordDecision } = await import(
  "@/app/api/admin/instagram/rights-decision/route"
);
const { disconnectInstagramAccount } = await import(
  "@/app/admin/settings/instagram/actions"
);
const { ResaleRightsDecisionForm } = await import(
  "@/app/admin/settings/instagram/decision-form"
);
const { setResaleRightsStatus } = await import("@/lib/resale-rights-review");

const DECISION_URL = "http://localhost/api/admin/instagram/rights-decision";

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
 * sends an empty file, which the action ignores.
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
async function renderFormForAccount(): Promise<FormData> {
  const review = await prisma.resaleRightsReview.findUnique({
    where: { instagramAccountId: "acc-1" },
    select: {
      status: true,
      route: true,
      validUntil: true,
      conditions: true,
      checklistVersion: true,
    },
  });

  const markup = renderToStaticMarkup(
    <ResaleRightsDecisionForm
      instagramAccountId="acc-1"
      review={review}
      action="/api/admin/instagram/rights-decision"
    />,
  );
  return formDataFromMarkup(markup);
}

async function storedReview() {
  return prisma.resaleRightsReview.findUniqueOrThrow({
    where: { instagramAccountId: "acc-1" },
  });
}

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: "admin-1", email: "admin@example.com", role: "ADMIN" },
  });
  await prisma.instagramAccount.create({
    data: {
      id: "acc-1",
      instagramUserId: "ig-1",
      username: "owner",
      accessTokenEncrypted: "sealed",
      tokenExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
      scopes: "instagram_business_basic",
      connectedByUserId: "admin-1",
    },
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
  await setResaleRightsStatus("acc-1", {
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
   * The generalised version of the two fail-opens found in review, and the
   * reason this is a loop rather than a list of fields: both bugs were "a
   * form field that does not round-trip its stored value", and a per-field
   * assertion only catches the fields someone thought to name. This walks
   * every column of the stored review, so a field added later is covered
   * the day it exists — including one added by a different bead.
   */
  it("changes nothing but the reviewer stamp when only the reason is edited", async () => {
    // Populate every writable column first, so nothing is trivially null.
    await setResaleRightsStatus("acc-1", {
      source: "ADMIN",
      actorUserId: "admin-1",
      actorEmail: "admin@example.com",
      status: "CLEARED",
      reason: "Signed assignment on file.",
      route: "CONTRACT",
      validUntil: VALID_UNTIL,
      conditions: "Editorial use only.",
      evidence: { key: "rights-evidence/acc-1/contract.pdf", sha256: "abc123" },
      restampChecklist: true,
    });

    const before = await storedReview();

    const form = await renderFormForAccount();
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
});

describe("editing one field does not silently change the others", () => {
  it("keeps validUntil when an admin only edits the conditions", async () => {
    const form = await renderFormForAccount();
    // Exactly what the reviewer does: retype the conditions, state a reason,
    // submit. Nothing else is touched.
    form.set("conditions", "Editorial use only. No political advertising.");
    form.set("reason", "Owner clarified the permitted uses.");

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
    const form = await renderFormForAccount();
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
    const form = await renderFormForAccount();
    form.set("validUntil", "");
    form.set("reason", "Contract renewed with no end date.");

    await expectRedirect(form, "rights=recorded");

    expect((await storedReview()).validUntil).toBeNull();
  });

  // Same bug, different field. `checklistVersion` decides *which* checklist
  // a clearance was granted under, and dropping a version from
  // ACCEPTED_CHECKLIST_VERSIONS is how a revision to the legal process
  // forces every account to be re-reviewed. Re-stamping it on any edit
  // quietly undoes that.
  it("keeps a retired checklistVersion when an admin only edits the conditions", async () => {
    // The account was cleared, then the checklist was revised and the
    // version it was cleared under retired.
    await prisma.resaleRightsReview.update({
      where: { instagramAccountId: "acc-1" },
      data: { checklistVersion: RETIRED_VERSION },
    });
    expect(ACCEPTED_CHECKLIST_VERSIONS.has(RETIRED_VERSION)).toBe(false);

    const form = await renderFormForAccount();
    form.set("conditions", "Editorial use only. No political advertising.");
    form.set("reason", "Owner clarified the permitted uses.");

    await expectRedirect(form, "rights=recorded");

    const review = await storedReview();
    expect(review.checklistVersion).toBe(RETIRED_VERSION);
    // And the account is still not sellable, which is the point of retiring
    // a version in the first place.
    expect(
      accountClearanceBlocker({
        status: review.status,
        checklistVersion: review.checklistVersion,
        reviewedByUserId: review.reviewedByUserId,
        validUntil: review.validUntil,
        reviewedBy: { role: "ADMIN" },
      }),
    ).toBe("checklist_version_retired");
  });

  it("re-stamps only when the reviewer says they re-ran the checklist", async () => {
    await prisma.resaleRightsReview.update({
      where: { instagramAccountId: "acc-1" },
      data: { checklistVersion: RETIRED_VERSION },
    });

    const form = await renderFormForAccount();
    form.set("reason", "Re-reviewed against the new checklist; still clear.");
    // What ticking the checkbox submits.
    form.set("restampChecklist", "yes");

    await expectRedirect(form, "rights=recorded");

    const review = await storedReview();
    expect(review.checklistVersion).toBe(CURRENT_CHECKLIST_VERSION);
    expect(
      accountClearanceBlocker({
        status: review.status,
        checklistVersion: review.checklistVersion,
        reviewedByUserId: review.reviewedByUserId,
        validUntil: review.validUntil,
        reviewedBy: { role: "ADMIN" },
      }),
    ).toBeNull();
  });

  it("carries the rendered expiry through as the same instant", async () => {
    // Guards the format seam: the form writes YYYY-MM-DD, the action parses
    // it back. A local-time formatter on either side moves the expiry a day.
    const form = await renderFormForAccount();
    expect(form.get("validUntil")).toBe("2027-06-01");
    form.set("reason", "No change.");

    await expectRedirect(form, "rights=recorded");

    expect((await storedReview()).validUntil?.toISOString()).toBe(
      "2027-06-01T00:00:00.000Z",
    );
  });
});

describe("disconnecting revokes before it deletes", () => {
  /**
   * Checklist Part E.3: admin disconnect → REVOKED. Without it, the audit
   * trail for a disconnected account ends on `toStatus = CLEARED` — the
   * trail survives the account (it has no foreign keys, by design) but its
   * last entry describes rights that ended when the account went away.
   */
  function disconnectForm(id = "acc-1"): FormData {
    const data = new FormData();
    data.set("id", id);
    return data;
  }

  it("ends the trail at REVOKED, naming the admin who disconnected", async () => {
    expect((await storedReview()).status).toBe("CLEARED");

    await disconnectInstagramAccount(disconnectForm());

    expect(
      await prisma.instagramAccount.findUnique({ where: { id: "acc-1" } }),
    ).toBeNull();
    // Cascades with the account, as intended: this is current state.
    expect(
      await prisma.resaleRightsReview.findUnique({
        where: { instagramAccountId: "acc-1" },
      }),
    ).toBeNull();

    const trail = await prisma.resaleRightsEvent.findMany({
      where: { instagramAccountId: "acc-1" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const last = trail.at(-1)!;
    expect(last).toMatchObject({
      fromStatus: "CLEARED",
      toStatus: "REVOKED",
      reason: "Account disconnected by an admin.",
      // Named as the trigger...
      actorUserId: "admin-1",
      actorEmail: "admin@example.com",
      instagramUsername: "owner",
    });
    // ...but never as the reviewer: disconnecting is not reviewing. The
    // clearing decision above is still the one that carries selfReview.
    expect(last.selfReview).toBe(false);
  });

  it("is a no-op on an account that is already gone", async () => {
    await disconnectInstagramAccount(disconnectForm());
    const before = await prisma.resaleRightsEvent.count();

    // Double submit, or a stale tab.
    await disconnectInstagramAccount(disconnectForm());

    expect(await prisma.resaleRightsEvent.count()).toBe(before);
  });

  it("refuses a non-admin, leaving both the account and the trail alone", async () => {
    authMock.mockResolvedValue({ user: { id: "admin-1", role: "USER" } });

    await expect(
      disconnectInstagramAccount(disconnectForm()),
    ).rejects.toThrow("Forbidden");

    expect(
      await prisma.instagramAccount.findUnique({ where: { id: "acc-1" } }),
    ).not.toBeNull();
    expect((await storedReview()).status).toBe("CLEARED");
  });

  // Restores the account for whatever runs next, since beforeEach only
  // rebuilds the review.
  afterEach(async () => {
    await prisma.instagramAccount.upsert({
      where: { id: "acc-1" },
      update: {},
      create: {
        id: "acc-1",
        instagramUserId: "ig-1",
        username: "owner",
        accessTokenEncrypted: "sealed",
        tokenExpiresAt: new Date("2027-01-01T00:00:00.000Z"),
        scopes: "instagram_business_basic",
        connectedByUserId: "admin-1",
      },
    });
  });
});

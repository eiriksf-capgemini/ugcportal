import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The full loop, against a real database: render the decision form for an
 * existing clearance, turn the rendered markup into the FormData a browser
 * would actually submit, change one unrelated field, and post it through the
 * real server action.
 *
 * This is the regression test for the one fail-OPEN path this feature had:
 * `validUntil` rendered without its current value, so editing the conditions
 * text silently turned a time-limited clearance into a perpetual one. Testing
 * it end to end rather than at the component alone is the point — the bug
 * lived in the seam between what the page rendered and what the action wrote,
 * and neither half was wrong on its own.
 */

const authMock = vi.fn();
const redirectMock = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT ${url}`);
});

vi.mock("@/lib/auth", () => ({ auth: authMock }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: redirectMock }));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { recordResaleRightsDecision } = await import(
  "@/app/admin/settings/instagram/actions"
);
const { ResaleRightsDecisionForm } = await import(
  "@/app/admin/settings/instagram/decision-form"
);
const { setResaleRightsStatus } = await import("@/lib/resale-rights-review");

const ADMIN = { user: { id: "admin-1", email: "admin@example.com", role: "ADMIN" } };
const VALID_UNTIL = new Date("2027-06-01T00:00:00.000Z");

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
    if (!name || attribute(tag, "type") === "file") continue;
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
    },
  });

  const markup = renderToStaticMarkup(
    <ResaleRightsDecisionForm
      instagramAccountId="acc-1"
      review={review}
      action={() => {}}
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
  redirectMock.mockClear();
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

describe("editing one field does not silently change the others", () => {
  it("keeps validUntil when an admin only edits the conditions", async () => {
    const form = await renderFormForAccount();
    // Exactly what the reviewer does: retype the conditions, state a reason,
    // submit. Nothing else is touched.
    form.set("conditions", "Editorial use only. No political advertising.");
    form.set("reason", "Owner clarified the permitted uses.");

    await expect(recordResaleRightsDecision(form)).rejects.toThrow(
      "rights=recorded",
    );

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

    await expect(recordResaleRightsDecision(form)).rejects.toThrow(
      "rights=recorded",
    );

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

    await expect(recordResaleRightsDecision(form)).rejects.toThrow(
      "rights=recorded",
    );

    expect((await storedReview()).validUntil).toBeNull();
  });

  it("carries the rendered expiry through as the same instant", async () => {
    // Guards the format seam: the form writes YYYY-MM-DD, the action parses
    // it back. A local-time formatter on either side moves the expiry a day.
    const form = await renderFormForAccount();
    expect(form.get("validUntil")).toBe("2027-06-01");
    form.set("reason", "No change.");

    await expect(recordResaleRightsDecision(form)).rejects.toThrow(
      "rights=recorded",
    );

    expect((await storedReview()).validUntil?.toISOString()).toBe(
      "2027-06-01T00:00:00.000Z",
    );
  });
});

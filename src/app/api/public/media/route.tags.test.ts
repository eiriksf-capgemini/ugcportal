import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";
import { seedMedia } from "@/lib/test-support/media-fixtures";

/**
 * GET /api/public/media (round-4 review of ugcportal-qnq9.7): the portfolio
 * curation tag must not reach a direct API consumer's JSON, independently
 * of whether any page renders it.
 *
 * route.test.ts (this directory's sibling) mocks `prisma.media.findMany`
 * with its own in-memory `Row` type, which has no `tags` field at all —
 * extending that mock to model the tags relation would duplicate what
 * src/app/page.tags.test.tsx already does, against a real database, for
 * the identical concern on the rendered-HTML side. Same approach here, on
 * the raw-JSON side: nothing below Prisma is mocked (besides `auth`, which
 * this anonymous feed must never consult — same reasoning as every other
 * file testing this feed).
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the public feed must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { GET } = await import("@/app/api/public/media/route");
const { PORTFOLIO_TAG_SLUG } = await import("@/lib/curation-tags");

const UPLOADER = "uploader-qnq9-7-api";

beforeAll(async () => {
  await applyMigrations(prisma);
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

beforeEach(async () => {
  await prisma.media.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.user.create({
    data: { id: UPLOADER, email: "uploader-qnq9-7-api@example.com", role: "USER" },
  });
  await prisma.tag.upsert({
    where: { slug: "food" },
    create: { slug: "food", name: "Food" },
    update: {},
  });
});

describe("the portfolio curation tag is absent from the raw JSON feed", () => {
  it("strips 'portfolio' from a row's tags, while keeping its real subject", async () => {
    await seedMedia(prisma, {
      id: "both-tagged",
      userId: UPLOADER,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      tags: ["food", PORTFOLIO_TAG_SLUG],
    });

    const response = await GET(new Request("http://localhost/api/public/media"));
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      items: { tags: { slug: string; name: string }[] }[];
    };
    expect(body.items).toHaveLength(1);
    const slugs = body.items[0].tags.map((tag) => tag.slug);
    expect(slugs).toEqual(["food"]);
    expect(slugs).not.toContain(PORTFOLIO_TAG_SLUG);
  });

  it("strips it even when it is the item's only tag", async () => {
    await seedMedia(prisma, {
      id: "portfolio-only",
      userId: UPLOADER,
      createdAt: new Date("2026-03-04T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
    });

    const response = await GET(new Request("http://localhost/api/public/media"));
    const body = (await response.json()) as {
      items: { tags: { slug: string; name: string }[] }[];
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].tags).toEqual([]);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * The brand entity behind a benefit (ugcportal-qnq9.1).
 *
 * The slug rules are pure and tested as such. `resolveBenefitSource` is tested
 * against a REAL temporary database rather than a mocked client, because the
 * two claims worth making about it are both claims a mock would simply agree
 * with: that a second call with a differently-spelled name finds the SAME row
 * (which is the whole reason the slug exists, and what ugcportal-qnq9.3's
 * alcohol answer will hang off), and that the first spelling is the one kept.
 */

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const {
  benefitSourceSlug,
  recordBrandAlcoholLinked,
  resolveBenefitSource,
  validateBenefitSourceName,
} = await import("@/lib/benefit-source");

const ADMIN_A = "admin-a-benefit-source";
const ADMIN_B = "admin-b-benefit-source";

beforeAll(async () => {
  await applyMigrations(prisma);
  await prisma.user.create({
    data: { id: ADMIN_A, email: "admin-a-benefit-source@example.com", role: "ADMIN" },
  });
  await prisma.user.create({
    data: { id: ADMIN_B, email: "admin-b-benefit-source@example.com", role: "ADMIN" },
  });
});

afterAll(async () => {
  await prisma.$disconnect();
  database.cleanup();
});

describe("benefitSourceSlug", () => {
  it.each([
    ["Riedel", "riedel"],
    ["riedel", "riedel"],
    ["  Riedel  ", "riedel"],
    ["Norsk Vin og Brennevin AS", "norsk-vin-og-brennevin-as"],
    ["Vinmonopolet!!", "vinmonopolet"],
    ["Coravin / Pro", "coravin-pro"],
    ["Hågen & Co", "hågen-co"],
    ["2 Brothers", "2-brothers"],
  ])("slugs %j to %j", (name, slug) => {
    expect(benefitSourceSlug(name.trim())).toBe(slug);
  });

  it("gives a composed and a decomposed spelling the same slug", () => {
    // Unlike the label lists (see labelWords in advertising-disclosure.ts),
    // a brand name is arbitrary text, so this one is real: "Rémy" typed with
    // a combining acute looks identical and must not become a second brand
    // with its own, separate alcohol answer.
    const composed = "Rémy";
    const decomposed = "Rémy";
    expect(composed).not.toBe(decomposed);
    expect(benefitSourceSlug(decomposed)).toBe(benefitSourceSlug(composed));
  });
});

describe("validateBenefitSourceName", () => {
  it("accepts a brand name and reports its slug", () => {
    expect(validateBenefitSourceName("  Riedel  ")).toEqual({
      ok: true,
      value: { slug: "riedel", name: "Riedel" },
    });
  });

  it.each([null, undefined, 42, {}, []])("rejects the non-string %j", (value) => {
    expect(validateBenefitSourceName(value).ok).toBe(false);
  });

  it.each(["", "   "])("rejects the blank %j", (value) => {
    expect(validateBenefitSourceName(value).ok).toBe(false);
  });

  it("rejects a name that is all punctuation", () => {
    // It would slug to the empty string, which is one shared identity that
    // every such submission collapses onto — unrelated brands sharing a row,
    // and later sharing an alcohol answer.
    const result = validateBenefitSourceName("---");
    expect(result.ok).toBe(false);
    expect(benefitSourceSlug("---")).toBe("");
  });

  it("rejects a name carrying a bidi override", () => {
    // The same denylist the rename and tag paths use (hasUnsafeText): a
    // right-to-left override reorders a brand name on screen exactly as
    // readily as it reorders a filename.
    expect(validateBenefitSourceName("Riedel‮").ok).toBe(false);
  });

  it("rejects a name over the length cap", () => {
    expect(validateBenefitSourceName("b".repeat(65)).ok).toBe(false);
    expect(validateBenefitSourceName("b".repeat(64)).ok).toBe(true);
  });

  it("counts the cap in code points, not UTF-16 units", () => {
    // 64 astral characters is 128 code units. Counting units would refuse a
    // name that is exactly at the limit.
    expect(validateBenefitSourceName("𝐁".repeat(64)).ok).toBe(true);
    expect(validateBenefitSourceName("𝐁".repeat(65)).ok).toBe(false);
  });
});

describe("resolveBenefitSource, against a real database", () => {
  it("mints a brand once and finds the same row for another spelling", async () => {
    const first = await resolveBenefitSource({ slug: "riedel", name: "Riedel" });
    const second = await resolveBenefitSource({ slug: "riedel", name: "RIEDEL" });

    expect(second).toBe(first);
    expect(await prisma.benefitSource.count({ where: { slug: "riedel" } })).toBe(
      1,
    );
  });

  it("keeps the first spelling as the display name", async () => {
    // `update: {}` — a later submission must not silently rename a brand on
    // every item that already named it.
    const row = await prisma.benefitSource.findUniqueOrThrow({
      where: { slug: "riedel" },
      select: { name: true },
    });
    expect(row.name).toBe("Riedel");
  });

  it("writes through the transaction it is handed", async () => {
    // The debris case resolveBenefitSource's docstring describes: a brand
    // minted for a write that then fails must not survive, and nothing in
    // this product deletes a BenefitSource.
    await expect(
      prisma.$transaction(async (tx) => {
        await resolveBenefitSource({ slug: "coravin", name: "Coravin" }, tx);
        throw new Error("the write after it failed");
      }),
    ).rejects.toThrow("the write after it failed");

    expect(
      await prisma.benefitSource.count({ where: { slug: "coravin" } }),
    ).toBe(0);
  });
});

describe("recordBrandAlcoholLinked (ugcportal-mqh8), against a real database", () => {
  async function seedBrand(slug: string, alcoholLinked: boolean | null) {
    return prisma.benefitSource.create({
      data: {
        slug,
        name: slug,
        alcoholLinked,
        alcoholAnsweredAt: alcoholLinked === null ? null : new Date("2026-01-01T00:00:00.000Z"),
        alcoholAnsweredByUserId: alcoholLinked === null ? null : ADMIN_A,
      },
    });
  }

  it("records an unchecked brand as alcohol-linked, dated and attributed", async () => {
    const brand = await seedBrand("mqh8-unchecked", null);

    const outcome = await recordBrandAlcoholLinked(brand.id, ADMIN_A);

    expect(outcome).toBe("recorded");
    const row = await prisma.benefitSource.findUniqueOrThrow({
      where: { id: brand.id },
      select: { alcoholLinked: true, alcoholAnsweredAt: true, alcoholAnsweredByUserId: true },
    });
    expect(row.alcoholLinked).toBe(true);
    expect(row.alcoholAnsweredAt).toBeInstanceOf(Date);
    expect(row.alcoholAnsweredByUserId).toBe(ADMIN_A);
  });

  it("records a brand previously answered `no` as alcohol-linked", async () => {
    const brand = await seedBrand("mqh8-previously-clean", false);

    const outcome = await recordBrandAlcoholLinked(brand.id, ADMIN_B);

    expect(outcome).toBe("recorded");
    expect(
      (
        await prisma.benefitSource.findUniqueOrThrow({
          where: { id: brand.id },
          select: { alcoholLinked: true },
        })
      ).alcoholLinked,
    ).toBe(true);
  });

  it("is a monotone no-op on a brand already recorded as alcohol-linked, by a DIFFERENT actor", async () => {
    const brand = await seedBrand("mqh8-already-linked", true);

    const outcome = await recordBrandAlcoholLinked(brand.id, ADMIN_B);

    expect(outcome).toBe("already-recorded");
    const row = await prisma.benefitSource.findUniqueOrThrow({
      where: { id: brand.id },
      select: { alcoholLinked: true, alcoholAnsweredAt: true, alcoholAnsweredByUserId: true },
    });
    // Unchanged: the `where` clause matches nothing once the brand already
    // carries an answer, so the first recording's date and name survive a
    // second attempt rather than being restamped by it.
    expect(row.alcoholLinked).toBe(true);
    expect(row.alcoholAnsweredAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(row.alcoholAnsweredByUserId).toBe(ADMIN_A);
  });

  it("reports a brand id that names no row", async () => {
    const outcome = await recordBrandAlcoholLinked("no-such-brand-id", ADMIN_A);
    expect(outcome).toBe("not-found");
  });

  it("has no parameter through which a caller could ever write `false`", () => {
    // Not a runtime assertion — there is no such call to make — but the
    // signature itself is the proof: the only two parameters are the brand
    // and the actor, so the function body is the only place `alcoholLinked`
    // is set, and it is set to the literal `true` there (see its own
    // docstring). A reviewer or a later edit that added a third parameter
    // here would widen the function's arity, which this length check pins.
    expect(recordBrandAlcoholLinked.length).toBe(2);
  });
});

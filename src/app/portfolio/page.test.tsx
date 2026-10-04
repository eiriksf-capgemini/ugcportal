import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { seedMedia } from "@/lib/test-support/media-fixtures";
import { applyMigrations, createTemporaryDatabase } from "@/lib/test-support/db";

/**
 * /portfolio (ugcportal-qnq9.7), K1/K2.
 *
 * Against a real database and the real migrations, same reasoning as
 * src/app/page.test.tsx: this is a claim about which rows reach the DOM,
 * which a mocked Prisma client cannot prove.
 */
vi.mock("@/lib/auth", () => ({
  auth: () => {
    throw new Error("the public portfolio page must not consult the session");
  },
}));

const database = createTemporaryDatabase();
const { prisma } = await import("@/lib/prisma");
const { default: PortfolioPage } = await import("@/app/portfolio/page");
const { PORTFOLIO_TAG_SLUG } = await import("@/lib/curation-tags");
const { SPEC_SAMPLE_LABEL } = await import("@/lib/portfolio");
const { CONTACT_EMAIL_PLACEHOLDER } = await import("@/lib/contact");

const UPLOADER = "uploader-portfolio-page";

async function renderPortfolio(): Promise<string> {
  return renderToStaticMarkup(await PortfolioPage());
}

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
    data: { id: UPLOADER, email: "uploader-portfolio-page@example.com", role: "USER" },
  });
});

describe("K1: /portfolio shows all five §5.3 elements", () => {
  it("renders intro, samples, offer and contact sections even with no samples yet", async () => {
    const markup = await renderPortfolio();
    expect(markup).toContain('data-page-section="intro"');
    expect(markup).toContain('data-page-section="samples"');
    expect(markup).toContain('data-page-section="offer"');
    expect(markup).toContain('data-page-section="contact"');
    expect(markup).toContain("data-portfolio-samples-empty");
  });

  it("renders a published, portfolio-tagged photo as a sample", async () => {
    await seedMedia(prisma, {
      id: "piece-1",
      userId: UPLOADER,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
      caption: "Flat-lay photo set, 6 images",
    });

    const markup = await renderPortfolio();
    expect(markup).toContain('data-portfolio-piece="piece-1"');
    expect(markup).toContain("Flat-lay photo set, 6 images");
    expect(markup).not.toContain("data-portfolio-samples-empty");
  });

  it("the contact form targets the configured (placeholder, in test) address, with the portfolio's own default subject", async () => {
    const markup = await renderPortfolio();
    expect(markup).toContain(CONTACT_EMAIL_PLACEHOLDER);
    expect(markup).toContain("Hello from your portfolio page");
  });
});

describe("K2: the spec marker", () => {
  it("appears on a rendered sample (every piece this release is self-made spec work)", async () => {
    await seedMedia(prisma, {
      id: "piece-spec",
      userId: UPLOADER,
      createdAt: new Date("2026-02-02T00:00:00.000Z"),
      tags: [PORTFOLIO_TAG_SLUG],
    });

    const markup = await renderPortfolio();
    expect(markup).toContain('data-portfolio-marker="spec"');
    expect(markup).toContain(SPEC_SAMPLE_LABEL);
  });
});

describe("release scope: photo pieces only (Eirik's 2026-10-04 note)", () => {
  it("does not render an untagged published photo as a sample", async () => {
    await seedMedia(prisma, {
      id: "piece-untagged",
      userId: UPLOADER,
      createdAt: new Date("2026-02-03T00:00:00.000Z"),
      tags: [],
    });

    const markup = await renderPortfolio();
    expect(markup).not.toContain('data-portfolio-piece="piece-untagged"');
  });

  it("does not render a portfolio-tagged VIDEO as a sample", async () => {
    await seedMedia(prisma, {
      id: "piece-video",
      userId: UPLOADER,
      createdAt: new Date("2026-02-04T00:00:00.000Z"),
      kind: "VIDEO",
      tags: [PORTFOLIO_TAG_SLUG],
    });

    const markup = await renderPortfolio();
    expect(markup).not.toContain('data-portfolio-piece="piece-video"');
  });
});

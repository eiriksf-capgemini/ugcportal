import type { prisma as PrismaSingleton } from "@/lib/prisma";

/**
 * Test-only helper (not imported by any application code): one Media row,
 * shaped the way the public feed and the portfolio selection both need it —
 * previewKey/previewId present (or deliberately withheld), altText,
 * optional caption, optional tags by slug.
 *
 * ONE COPY, used by src/lib/portfolio.test.ts and
 * src/app/portfolio/page.test.tsx (round-1 review: each of those files used
 * to carry its own near-identical `seedMedia`, which is exactly the
 * "sibling-omission" shape review-standards' family 4 names — a fixture
 * shared by two test files that can quietly drift apart about what a
 * published, tagged, previewed row looks like). `import type` only for the
 * Prisma client, so this module has no runtime import of its own and cannot
 * initialise a client against the wrong `DATABASE_URL` before a test's
 * `createTemporaryDatabase()` has set one.
 */
export type SeedMediaOptions = {
  id: string;
  userId: string;
  createdAt: Date;
  kind?: "IMAGE" | "VIDEO";
  tags?: string[];
  published?: boolean;
  withPreview?: boolean;
  caption?: string;
  altText?: string;
};

export async function seedMedia(
  client: Pick<typeof PrismaSingleton, "media">,
  {
    id,
    userId,
    createdAt,
    kind = "IMAGE",
    tags = [],
    published = true,
    withPreview = true,
    caption,
    altText,
  }: SeedMediaOptions,
): Promise<void> {
  await client.media.create({
    data: {
      id,
      userId,
      kind,
      key: `media/${userId}/${id}-original.jpg`,
      previewKey: withPreview ? `previews/${userId}/${id}.webp` : null,
      previewId: withPreview ? `pv-${id}` : null,
      mimeType: kind === "VIDEO" ? "video/mp4" : "image/jpeg",
      sizeBytes: 4096,
      originalName: `${id}.jpg`,
      altText: altText ?? `Alt text for ${id}`,
      caption,
      createdAt,
      publishedAt: published ? new Date("2026-03-04T10:00:00.000Z") : null,
      tags: { connect: tags.map((slug) => ({ slug })) },
    },
  });
}

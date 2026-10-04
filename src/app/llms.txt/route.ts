import { SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";

/**
 * Generate the /llms.txt file per the llmstxt.org specification.
 *
 * This describes the site's public purpose and structure for AI crawlers and agents.
 * It must never list admin-only routes, API routes, upload pages, or non-public content.
 *
 * Format per https://llmstxt.org:
 * - H1 with site name
 * - Blockquote with summary
 * - H2 sections with markdown link lists to public content
 */
export function GET(): Response {
  const content = `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

## Public Gallery

The public photo gallery showcasing watermarked previews of user-generated content across food, wine, drinks, technology, and books.

- [Home](/): Browse the public gallery
- [Public Gallery Feed](/api/public/media): Access the paginated photo feed

## Gallery Navigation

- [API Documentation](/docs): Technical details for integrating with the gallery feed

`;

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400", // Cache for 1 day
    },
  });
}

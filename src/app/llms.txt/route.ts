import { SITE_NAME, SITE_DESCRIPTION } from "@/lib/site";

/**
 * Generate the /llms.txt file per the llmstxt.org specification.
 *
 * This describes the site's public purpose and structure for AI crawlers and agents.
 * It must never list admin-only routes, upload pages, or non-public content.
 *
 * Format per https://llmstxt.org:
 * - H1 with site name
 * - Blockquote with summary
 * - H2 sections with prose and markdown link lists to public content
 */
export function GET(): Response {
  const content = `# ${SITE_NAME}

> ${SITE_DESCRIPTION}

## Public Gallery

A public gallery of watermarked photographs with alt text and captions. Contributors are members of a configured allowlist of permitted uploaders. Each contributor publishes their own work. Photography covers food, wine and drink, technology, and books.

- [Home](/): Browse the public gallery

`;

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400", // Cache for 1 day
    },
  });
}

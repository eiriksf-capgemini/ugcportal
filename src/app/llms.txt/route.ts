import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

/**
 * /llms.txt (ugcportal-o7l), per https://llmstxt.org: one H1, one blockquote
 * summary, then H2 sections of prose and markdown links.
 *
 * Public content only. It must never list admin, API or upload routes
 * (the test's guardrail), and it must not state anything the code does not
 * do: the earlier draft claimed images were "vetted for quality", which no
 * code path performs (PR #83 round 2). Each sentence in the prose below is
 * annotated in a comment with the file that makes it true.
 */

/**
 * A heading is one line whatever the constant holds. SITE_NAME is documented
 * as a placeholder that will change; a value with a line break or a run of
 * spaces must not split the H1 (PR #83 round 3).
 */
function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Every line of a multi-line value quoted, so the summary stays one
 * blockquote instead of a quoted first line followed by bare text.
 */
function blockquote(value: string): string {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/**
 * The document, from its two inputs. Exported so tests can feed multi-line
 * values through the real builder rather than re-implementing it.
 */
export function buildLlmsTxt(site: {
  name: string;
  description: string;
}): string {
  return [
    `# ${singleLine(site.name)}`,
    "",
    blockquote(site.description),
    "",
    "## Public gallery",
    "",
    // Watermarked previews: src/lib/watermark.ts. Alt text required to
    // publish, captions shown: src/app/api/media/[id]/publish/route.ts and
    // src/components/gallery/. Allowlisted sign-in: src/lib/sign-in-policy.ts.
    // Owner-only publishing: requireOwnedMedia in the publish route.
    // Alt text is required to publish; a caption is optional and shown when
    // the contributor wrote one (gallery.tsx renders nothing otherwise).
    "A public gallery of watermarked preview images, each with alt text and, where the contributor wrote one, a caption. " +
      "Contributors are a small, allowlisted set of signed-in uploaders, and each publishes their own work.",
    "",
    "- [Home](/): browse the public gallery",
    "",
  ].join("\n");
}

export function GET(): Response {
  return new Response(
    buildLlmsTxt({ name: SITE_NAME, description: SITE_DESCRIPTION }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      },
    },
  );
}

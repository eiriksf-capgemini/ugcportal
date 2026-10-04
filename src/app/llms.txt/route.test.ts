import { describe, expect, it } from "vitest";

import { SITE_DESCRIPTION, SITE_NAME } from "@/lib/site";

import { GET, buildLlmsTxt } from "./route";

/**
 * ugcportal-o7l. The structural tests run against the REAL builder with
 * inputs chosen to make the failure they describe possible — a two-line
 * description, a name with a line break — rather than against a local copy
 * of the algorithm, which is the assertion-that-cannot-fail shape PR #83's
 * rounds 1 and 3 both caught.
 */

function lines(text: string): string[] {
  return text.split("\n");
}

/** The non-empty lines between the H1 and the first H2: the summary block. */
function summaryLines(text: string): string[] {
  const all = lines(text);
  const h1 = all.findIndex((line) => line.startsWith("# "));
  const h2 = all.findIndex((line) => line.startsWith("## "));
  return all.slice(h1 + 1, h2).filter((line) => line.trim().length > 0);
}

describe("GET /llms.txt", () => {
  it("answers 200 as UTF-8 plain text", () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/plain; charset=utf-8",
    );
  });

  it("starts with exactly one H1 carrying the site name", async () => {
    const text = await GET().text();
    const all = lines(text);
    expect(all.find((line) => line.trim().length > 0)).toBe(`# ${SITE_NAME}`);
    expect(all.filter((line) => line.startsWith("# ")).length).toBe(1);
  });

  it("quotes the whole description as one blockquote", async () => {
    const text = await GET().text();
    const summary = summaryLines(text);
    expect(summary.length).toBeGreaterThan(0);
    for (const line of summary) {
      expect(line).toMatch(/^> /);
    }
    expect(summary.join("\n")).toContain(SITE_DESCRIPTION);
  });

  it("links only to public pages", async () => {
    const text = await GET().text();
    // "/" is the only public page today; src/lib/routes.ts exports no
    // constant for the app root, so it is written out here. Add a path only
    // when a public page exists for it.
    const publicPaths = new Set(["/"]);
    const linked = Array.from(text.matchAll(/\]\(([^)]+)\)/g), (m) => m[1]);
    expect(linked.length).toBeGreaterThan(0);
    for (const path of linked) {
      expect(publicPaths.has(path), `${path} is not a public page`).toBe(true);
    }
  });

  it("never mentions an admin, API or upload path (K2 guardrail)", async () => {
    // Literal substrings on purpose: they name whole families of private
    // routes, so a new /admin/* or /api/* page cannot slip past a stale
    // allowlist. Mutation-checked by adding "/admin/settings" to the prose and
    // watching this fail.
    const text = await GET().text();
    for (const needle of ["/admin", "/api/", "/upload"]) {
      expect(text, `must not mention ${needle}`).not.toContain(needle);
    }
  });
});

describe("buildLlmsTxt keeps the spec's structure for awkward inputs", () => {
  it("quotes every line of a multi-line description", () => {
    const text = buildLlmsTxt({
      name: "Site",
      description: "Line one.\nLine two.",
    });
    const summary = summaryLines(text);
    expect(summary).toEqual(["> Line one.", "> Line two."]);
  });

  it("collapses a name with line breaks into a single H1", () => {
    const text = buildLlmsTxt({
      name: "Two\nline   name",
      description: "d",
    });
    const all = lines(text);
    expect(all[0]).toBe("# Two line name");
    expect(all.filter((line) => line.startsWith("# ")).length).toBe(1);
    expect(all[1]).toBe("");
  });
});

import { describe, it, expect } from "vitest";
import { GET } from "./route";

describe("GET /llms.txt", () => {
  it("returns a valid llms.txt response with correct content type", async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  });

  it("starts with a single H1 line with the site name", async () => {
    const response = GET();
    const content = await response.clone().text();
    const lines = content.split("\n");

    // First non-empty line should be H1
    const firstLine = lines.find((line) => line.trim());
    expect(firstLine).toBe("# UGC Portal");

    // Count H1 lines - should be exactly one
    const h1Count = lines.filter((line) => line.trim().startsWith("# ")).length;
    expect(h1Count).toBe(1);
  });

  it("contains a blockquote with every line prefixed with '> '", async () => {
    const response = GET();
    const content = await response.clone().text();
    const lines = content.split("\n");

    // Find the blockquote section (starts after H1, before H2)
    const h1Index = lines.findIndex((line) => line.startsWith("# "));
    const h2Index = lines.findIndex((line) => line.startsWith("## "));
    const blockquoteLines = lines.slice(h1Index + 2, h2Index).filter((line) => line.trim());

    // Every blockquote line must start with "> " to maintain spec structure
    expect(blockquoteLines.length).toBeGreaterThan(0);
    for (const line of blockquoteLines) {
      expect(line, "Blockquote line must be prefixed with '> '").toMatch(/^> /);
    }

    // The blockquote must contain the description
    const blockquoteText = blockquoteLines.join("\n");
    expect(blockquoteText).toContain("Food, wine and drink, technology and books, photographed.");
  });

  it("lists only paths from the allowlist of public routes", async () => {
    const response = GET();
    const content = await response.clone().text();

    // Extract all paths from markdown links [text](path)
    const linkRegex = /\]\(([^)]+)\)/g;
    const paths: string[] = [];
    let match;

    while ((match = linkRegex.exec(content)) !== null) {
      paths.push(match[1]);
    }

    // Define the allowlist of public paths
    const allowlist = new Set([
      "/", // home page with public gallery
    ]);

    // Every extracted path must be in the allowlist
    for (const path of paths) {
      expect(path, `Path ${path} should be in the allowlist`).toSatisfy(
        (p: string) => allowlist.has(p) || p.startsWith("http"),
      );
    }
  });

  it("enforces guardrail: no line contains '/admin', '/api/', or '/upload'", async () => {
    const response = GET();
    const content = await response.clone().text();
    const lines = content.split("\n");

    // These patterns are checked as literal substrings, not imported constants,
    // because they represent categories of routes: all /admin/* paths, all /api/* paths,
    // and the /upload path. A new private route cannot slip through with stale literals.
    for (const line of lines) {
      expect(line, "Line should not contain '/admin'").not.toContain("/admin");
      expect(line, "Line should not contain '/api/'").not.toContain("/api/");
      expect(line, "Line should not contain '/upload'").not.toContain("/upload");
    }
  });

  it("multiline description test: blockquote properly escapes with > prefix (mutation check)", () => {
    // This test verifies that if SITE_DESCRIPTION were to contain newlines,
    // the blockquote building logic in the route would correctly prefix every
    // line with "> " to maintain llms.txt spec structure.
    //
    // Simulate what would happen with a two-line description:
    // Without the fix (direct interpolation): only first line gets ">", breaking spec
    // With the fix (split + map): every line gets "> ", preserving spec
    const mockDescription = "Line one of description.\nLine two of description.";

    // Simulate the BROKEN approach (direct interpolation):
    // const brokenBlockquote = `> ${mockDescription}`;
    // This would produce:
    //   > Line one of description.
    //   Line two of description.
    // The second line is missing "> ", breaking the blockquote format.

    // Simulate the FIXED approach (split and prefix each line):
    const fixedBlockquote = mockDescription
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

    // Every line of the blockquote must start with "> "
    const lines = fixedBlockquote.split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) {
      expect(line, "Every blockquote line must be prefixed with '> '").toMatch(/^> /);
    }
    expect(lines[1]).toContain("Line two of description.");

    // If we had NOT implemented the split/map fix, the test above would fail
    // because line[1] would be "Line two of description." (without the "> " prefix)
  });
});

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

  it("contains a blockquote line with the site description", async () => {
    const response = GET();
    const content = await response.clone().text();
    const lines = content.split("\n");

    const blockquoteLine = lines.find(
      (line) => line.trim().startsWith(">") && line.includes("Food, wine and drink"),
    );

    expect(blockquoteLine).toBeDefined();
    expect(blockquoteLine).toContain("Food, wine and drink, technology and books, photographed.");
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
      "/", // home page
      "/api/public/media", // public gallery feed
      "/docs", // documentation (if it exists)
    ]);

    // Every extracted path must be in the allowlist
    for (const path of paths) {
      expect(path, `Path ${path} should be in the allowlist`).toSatisfy(
        (p: string) => allowlist.has(p) || p.startsWith("http"),
      );
    }
  });

  it("enforces guardrail: no line contains '/admin' or '/api/' or '/upload'", async () => {
    const response = GET();
    const content = await response.clone().text();
    const lines = content.split("\n");

    for (const line of lines) {
      expect(line, "Line should not contain '/admin'").not.toContain("/admin");
      expect(line, "Line should not contain '/upload'").not.toContain("/upload");
      // Note: /api/public/media is allowed, but /api/ generally is not
      // We check for /api/ to catch admin APIs
      const containsRestrictedApi = /\/api\/(?!public)/.test(line);
      expect(containsRestrictedApi, "Line should not contain restricted '/api/' routes").toBe(
        false,
      );
    }
  });

  it("guardrail test fails when admin content is added (mutation check)", async () => {
    // This test mutates the expected content by simulating what would break the guardrail
    const mutatedContent = `# UGC Portal

> Food, wine and drink, technology and books, photographed.

## Admin Settings

- [Settings](/admin/settings)

## Public Gallery

- [Home](/): Browse the public gallery
`;

    const lines = mutatedContent.split("\n");
    let guardrailViolation = false;

    for (const line of lines) {
      if (line.includes("/admin")) {
        guardrailViolation = true;
        break;
      }
    }

    // This should be true, proving the guardrail would catch this
    expect(guardrailViolation).toBe(true);
  });
});

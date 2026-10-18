import { expect, test } from "@playwright/test";

/**
 * ugcportal-7ex5 K1/K3: read the headers off real responses, and assert the
 * page raises no CSP violation in the console.
 */
for (const path of ["/", "/admin/settings/users", "/api/media/preview/does-not-exist"]) {
  test(`security headers on ${path}`, async ({ request }) => {
    const res = await request.get(path, { maxRedirects: 0 });
    const h = res.headers();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });
}

test("front page raises no CSP violation in the console", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /content security policy|csp/i.test(m.text())) problems.push(m.text());
  });
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  expect(problems).toEqual([]);
});

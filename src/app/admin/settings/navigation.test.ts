import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { INSTAGRAM_SETTINGS_PATH, RIGHTS_SETTINGS_PATH } from "@/lib/routes";

/**
 * There is no admin navigation component, so every admin screen is reachable
 * only from links the other admin screens carry. That makes "which screens
 * link to which" a real property rather than a styling detail — a screen
 * nobody links to is a screen an operator finds by guessing a URL.
 *
 * It bit this bead: ugcportal-vsm moved the resale-rights screen off the
 * Instagram settings page, and for a while the only in-app link to it was
 * still the one on that page — the *deferred* feature. An operator who never
 * connects an Instagram account had no discoverable route to the one screen
 * that gates all selling.
 *
 * The rule asserted is deliberately narrow rather than "every screen links
 * to every other", which would be arbitrary: the resale-rights screen must
 * be reachable from an admin screen that is not the deferred one. Screens
 * are read off disk, so adding another admin settings page does not quietly
 * fall outside the scan.
 */

const SETTINGS_DIR = resolve(process.cwd(), "src/app/admin/settings");

/** `{ directory name -> page source }` for every admin settings screen. */
function settingsPages(): Map<string, string> {
  const pages = new Map<string, string>();
  for (const entry of readdirSync(SETTINGS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const page = join(SETTINGS_DIR, entry.name, "page.tsx");
    try {
      pages.set(entry.name, readFileSync(page, "utf8"));
    } catch {
      // A directory with no page.tsx is a helper module, not a screen.
    }
  }
  return pages;
}

const PAGES = settingsPages();

/**
 * Whether a page actually LINKS to a path — not merely mentions it.
 *
 * The `href=` context is load-bearing and was missing from the first version
 * of this helper, which matched a bare occurrence of the constant anywhere
 * in the file. That made the guard pass on a page that still *imported*
 * `RIGHTS_SETTINGS_PATH` while rendering no link at all, which is precisely
 * the state this test was written to catch — a check comparing the wrong two
 * things, found by mutating the page rather than by reading the helper.
 *
 * Both spellings count: the constants exist so paths are not duplicated, but
 * a test that only recognised the constant would fail on a perfectly good
 * hard-coded link and teach the next person to work around it.
 */
function linksTo(source: string, constantName: string, path: string): boolean {
  // `[^}]*` is enough for the template-literal form too — in
  // href={`${CONST}?edit=...`} the constant sits before the first `}`.
  const viaConstant = new RegExp(`href=\\{[^}]*\\b${constantName}\\b`);
  return viaConstant.test(source) || source.includes(`href="${path}"`);
}

describe("the admin settings screens are reachable from one another", () => {
  it("found the screens to scan", () => {
    // Guards the scan itself.
    expect([...PAGES.keys()].sort()).toEqual(["instagram", "rights", "users"]);
  });

  it("links to resale rights from another screen that is not the deferred one", () => {
    // Two exclusions, both learned by mutating the page rather than by
    // reading this test:
    //
    //   - "instagram", because it is deferred (ugcportal-ct0 and siblings),
    //     so a link that only exists there is not a route an operator has;
    //   - "rights" itself, because the screen links to itself on every row
    //     (`?edit=<id>` opens one decision form at a time). Counting that as
    //     inbound made this assertion pass with the users-screen link
    //     deleted — a screen cannot make itself reachable.
    const others = [...PAGES].filter(
      ([name]) => name !== "instagram" && name !== "rights",
    );
    expect(others.map(([name]) => name)).not.toEqual([]);

    const linking = others
      .filter(([, source]) =>
        linksTo(source, "RIGHTS_SETTINGS_PATH", RIGHTS_SETTINGS_PATH),
      )
      .map(([name]) => name);

    expect(linking).not.toEqual([]);
  });

  it("does not leave the resale-rights screen as a dead end", () => {
    // It gates all selling, so an admin who lands on it should be able to
    // reach the screen that decides who may record a decision at all.
    const rights = PAGES.get("rights")!;

    expect(linksTo(rights, "ADMIN_USERS_PATH", "/admin/settings/users")).toBe(
      true,
    );
  });

  it("still points from the Instagram screen at where rights now live", () => {
    // Connecting an account confers no right to sell anything, and the
    // screen says so; the link is what makes that sentence actionable.
    const instagram = PAGES.get("instagram")!;

    expect(
      linksTo(instagram, "RIGHTS_SETTINGS_PATH", RIGHTS_SETTINGS_PATH),
    ).toBe(true);
    // And it no longer hosts the decision form itself.
    expect(instagram).not.toContain("ResaleRightsDecisionForm");
  });

  it("keeps the Instagram screen's own path constant in use", () => {
    // Cheap guard against the settings paths drifting apart from routes.ts,
    // which is what they exist to prevent.
    expect(INSTAGRAM_SETTINGS_PATH).toBe("/admin/settings/instagram");
    expect(RIGHTS_SETTINGS_PATH).toBe("/admin/settings/rights");
  });
});

// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { contrastRatio, parseColor } from "@/lib/design/color";
import { THRESHOLDS } from "@/lib/design/contrast";
import {
  GLOBALS_CSS_PATH,
  loadThemeTokens,
  resolveToken,
  type ThemeMode,
} from "@/lib/design/tokens";

/**
 * PR #94 review round 1 (medium): the toggle used to ship Button's `ghost`
 * variant, whose text colour is `text-ink` (src/components/ui/button.tsx) -
 * documented there as measured and safe only inside one of the old
 * near-black wells, never against `--background`. The toggle sits directly
 * on the header's `bg-background`, where `--color-ink` measures roughly
 * 1.1:1 in light mode - the icon was functionally invisible.
 *
 * This resolves whichever foreground-colour utility the toggle's REAL
 * rendered className actually carries (not a hand-typed assumption of which
 * variant it uses) to the real custom-property token, then computes its
 * actual contrast against `--background` straight from the shipped
 * stylesheet, for both colour schemes - the same `src/lib/design/color.ts`
 * maths `src/lib/design/contrast.ts`'s system-wide pairings use, applied
 * directly to this one component so a future variant change that reads fine
 * in one mode but not the other cannot slip past the broader gate by
 * accident (that gate's own "link-on-background" entry already covers the
 * `outline` variant's `text-primary`/`--primary` pairing this component
 * relies on today, at the stricter 4.5:1 body threshold; this test pins the
 * COMPONENT's choice, not just the token's general safety, so a regression
 * here is a component-local, instantly diagnosable failure rather than a
 * seemingly unrelated contrast.test.ts failure three files away).
 */
const pathnameMock = vi.fn(() => "/");
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

const { MobileNavToggle } = await import("./mobile-nav-toggle");

const ITEMS = [{ href: "/", label: "Gallery" }];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  vi.clearAllMocks();
  pathnameMock.mockReturnValue("/");
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function toggleButton(): HTMLButtonElement {
  const button = container.querySelector("button");
  if (!button) throw new Error("mobile nav toggle button not found");
  return button;
}

/**
 * The only foreground-colour utilities button.tsx's variants actually use
 * for text/icon colour (see PETROL_OUTLINE_STYLE, NEUTRAL_OUTLINE_STYLE and
 * the `ghost`/`default`/`destructive`/`link` variant strings there) - not a
 * general Tailwind class scanner, which this narrow, component-local
 * regression test does not need. Refuses rather than guesses if the
 * component ever starts shipping a utility this map does not know, the same
 * "never silently skip" contract src/lib/design/usage.ts holds itself to.
 */
const FOREGROUND_TOKEN_BY_CLASS: Record<string, string> = {
  "text-ink": "--color-ink",
  "text-primary": "--primary",
  "text-foreground": "--foreground",
  "text-destructive": "--destructive",
};

function resolveToggleForegroundToken(classList: string): string {
  const classes = classList.split(/\s+/);
  const matches = classes.filter((name) => name in FOREGROUND_TOKEN_BY_CLASS);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one recognised foreground-colour utility on the toggle button's ` +
        `className, found [${matches.join(", ")}] in: ${classList}`,
    );
  }
  return FOREGROUND_TOKEN_BY_CLASS[matches[0]];
}

describe("MobileNavToggle K3 contrast (ugcportal-14k9 PR #94 review round 1)", () => {
  it.each<ThemeMode>(["light", "dark"])(
    "the toggle's foreground colour clears the 3:1 UI threshold against --background in %s mode",
    (mode) => {
      act(() => {
        root.render(<MobileNavToggle items={ITEMS} />);
      });

      const token = resolveToggleForegroundToken(toggleButton().className);
      const themeTokens = loadThemeTokens(GLOBALS_CSS_PATH, mode);
      const foreground = parseColor(resolveToken(token, themeTokens));
      const background = parseColor(resolveToken("--background", themeTokens));
      const ratio = contrastRatio(foreground, background);

      expect(
        ratio,
        `${token} on --background in ${mode} mode measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(THRESHOLDS.ui);
    },
  );
});

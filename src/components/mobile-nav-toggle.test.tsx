// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ugcportal-14k9 K1/K3: the small-viewport "mobile menu" is the one
 * genuinely interactive piece this bead adds (open/close state), so - like
 * src/components/upload-link.test.tsx - this needs a real DOM and a real
 * client root rather than a single static render: the property under test
 * (does activating the toggle button actually reveal the nav, and can a
 * keyboard user reach it) cannot be observed any other way. jsdom pinned at
 * ^26 for the same CI-Node-20 reason noted there.
 */
const pathnameMock = vi.fn(() => "/");
vi.mock("next/navigation", () => ({ usePathname: pathnameMock }));

const { MobileNavToggle } = await import("./mobile-nav-toggle");

const ITEMS = [
  { href: "/", label: "Gallery" },
  { href: "/about", label: "About" },
];

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

function panel(): HTMLElement | null {
  return container.querySelector('nav[aria-label="Main navigation"]');
}

describe("MobileNavToggle (ugcportal-14k9)", () => {
  it("starts closed: aria-expanded is false and the panel is not in the DOM", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
    expect(toggleButton().textContent).toContain("Open menu");
  });

  it("K1: activating the toggle opens the panel, with every nav item reachable inside it", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });

    expect(toggleButton().getAttribute("aria-expanded")).toBe("true");
    expect(toggleButton().textContent).toContain("Close menu");
    const nav = panel();
    expect(nav, "panel did not open").not.toBeNull();
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/", "/about"]);
    expect(links.map((a) => a.textContent)).toEqual(["Gallery", "About"]);
  });

  it("activating the toggle again closes the panel", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    expect(panel()).not.toBeNull();

    act(() => {
      toggleButton().click();
    });

    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
  });

  it("selecting a nav item inside the open panel closes it", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    const link = panel()?.querySelector("a");
    expect(link, "no link found in the open panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(panel()).toBeNull();
  });

  /**
   * THE FIXTURE MUTATION (review-standards family 3): confirms the K1 test
   * above is actually checking something that can fail, by running the same
   * assertions against a markup shape where the panel is open but EMPTY -
   * the bug a `.map()` over the wrong (e.g. always-empty) items array would
   * produce, which a looser assertion like "the panel contains some <a>
   * tags" would not catch.
   */
  it("the K1 item-reachability assertion fails against an empty panel", () => {
    act(() => {
      root.render(<MobileNavToggle items={[]} />);
    });

    act(() => {
      toggleButton().click();
    });

    const nav = panel();
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(() => {
      expect(links.map((a) => a.getAttribute("href"))).toEqual(["/", "/about"]);
    }).toThrow();
  });
});

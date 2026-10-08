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
  stubMatchMedia();
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
 * `document`, not `container`: `@base-ui/react/popover`'s `Popover.Portal`
 * renders the panel into `document.body` by default (PR #94 review round
 * 3), not as a DOM descendant of the toggle button's own wrapper the way
 * the hand-rolled `{open && <nav>...}` version used to.
 */
function panel(): HTMLElement | null {
  return document.querySelector('nav[aria-label="Main navigation"]');
}

/**
 * jsdom ships no `window.matchMedia` at all (confirmed empirically, same as
 * src/components/gallery/gallery.unmount.test.tsx's own PhotoSwipe stub
 * needing one for the same reason) - stubbed here, scoped to this file only,
 * so the dismiss-on-resize effect below has something real to attach a
 * "change" listener to. Captures that listener so the test can fire it by
 * hand, rather than trying to make jsdom's own (nonexistent) viewport
 * actually resize.
 *
 * `removeEventListener` only clears `matchMediaChangeListener` when the
 * function it is PASSED is the same one that was recorded (PR #94 review
 * round 6 finding 1): a stub that nulled the slot for ANY `"change"` removal
 * call, regardless of which handler, would make the two "removed on
 * close"/"removed on unmount" tests below pass even if the real component's
 * cleanup called `removeEventListener("change", someOtherFunction)` - the
 * exact shape of a genuinely leaked listener. Checked against a real DOM
 * API's own contract (`removeEventListener` is a no-op unless the handler
 * reference matches), not invented for this stub.
 */
let matchMediaChangeListener: ((event: MediaQueryListEvent) => void) | null = null;

function stubMatchMedia(): void {
  matchMediaChangeListener = null;
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change") matchMediaChangeListener = listener;
    },
    removeEventListener: (type: string, listener: (event: MediaQueryListEvent) => void) => {
      if (type === "change" && matchMediaChangeListener === listener) {
        matchMediaChangeListener = null;
      }
    },
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/**
 * `@base-ui/react/popover`'s floating-ui-based positioning and its dismiss
 * listeners both settle across a microtask/effect cycle beyond the one
 * `act()` flushes synchronously for the triggering click itself - confirmed
 * empirically: without this, the two tests below that dispatch a dismissal
 * event immediately after opening the panel found nothing listening yet.
 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
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

  /**
   * ugcportal-14k9 PR #94 review round 4, finding 3: Popover.Trigger's own
   * default `aria-haspopup="dialog"` agreed with Popup's own now-overridden
   * default role - once the panel's real role became "navigation", the
   * trigger's claim that activating it opens a DIALOG was simply wrong, and
   * relabelling it to another ARIA token (e.g. "menu") would have been just
   * as wrong - this disclosure's items are plain links, not real menuitems
   * with arrow-key roving focus. Checked for ABSENCE, not for an empty
   * string / "false": `aria-haspopup={undefined}` must make React omit the
   * attribute entirely (WAI-ARIA's own disclosure pattern uses no
   * aria-haspopup at all), not render a present-but-empty one.
   */
  it("carries no aria-haspopup - it discloses plain content, not a dialog or menu", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    expect(toggleButton().hasAttribute("aria-haspopup")).toBe(false);
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

  /**
   * ugcportal-14k9 PR #94 review round 4, finding 1: the panel used to carry
   * `z-10` on its positioner, below the header's own sticky `z-20`
   * (src/components/app-shell.tsx) - once the page was scrolled far enough
   * for the header to be genuinely "stuck" in front of content, the open
   * panel painted UNDER it instead of over it. Checked by finding the
   * element that actually carries the z-index utility and confirming it is
   * a real ANCESTOR of the rendered panel, not merely that "z-30" appears
   * somewhere in the document.
   */
  it("the panel's positioner renders above the header's own sticky z-20", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });

    const positioner = document.querySelector(".z-30");
    expect(positioner, "no element carrying z-30 found while the panel is open").not.toBeNull();
    expect(positioner?.contains(panel())).toBe(true);
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
   * ugcportal-14k9 PR #94 review round 6, finding 4: a Cmd/Ctrl-click (or a
   * middle-click, or Shift/Alt-click) on a nav item opens the destination in
   * a NEW tab, leaving the visitor still on this page with the panel they
   * were using now closed out from under them for no reason they caused. A
   * plain left click, with none of those modifiers, must still close it -
   * checked against the SAME link in the SAME open panel, so this cannot
   * pass by accident on a panel that would have stayed open (or closed)
   * regardless of which click reached it.
   */
  it("a Cmd-click leaves the panel open; a plain click on the same link still closes it", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    const link = panel()?.querySelector("a");
    expect(link, "no link found in the open panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
      );
    });
    expect(panel(), "a Cmd-click closed the panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(panel(), "a plain click did not close the panel").toBeNull();
  });

  /**
   * ugcportal-0sdf K2: `isPlainLeftClick`
   * (src/components/primary-nav-link.tsx) checks five things -
   * `!event.defaultPrevented`, `event.button === 0`, and the three
   * modifier keys - but only the
   * `metaKey` clause had a test above it (the Cmd-click case). The other
   * four clauses could each be deleted from the real guard and every test
   * in this file would still pass. One test per remaining clause below,
   * each structured exactly like the Cmd-click case above (open the panel,
   * click the same link with one clause tripped and confirm it stays open,
   * then a plain click on the same link and confirm it closes) so each is
   * provably tied to its own `isPlainLeftClick` condition and not to some
   * other path that happens to also leave the panel open.
   *
   * MUTATION (performed once per clause, verified, and reverted - not left
   * in the tree): removed the matching `!event.<x>` conjunct from
   * `isPlainLeftClick` in primary-nav-link.tsx and reran this file.
   *   - `!event.ctrlKey` removed: "a Ctrl-click leaves the panel open..."
   *     failed - `expect(panel(), "a Ctrl-click closed the panel").not.toBeNull()`
   *     got `null` (the panel closed on the Ctrl-click once the clause
   *     guarding it was gone).
   *   - `!event.shiftKey` removed: "a Shift-click leaves the panel open..."
   *     failed the same way for the Shift-click assertion.
   *   - `!event.altKey` removed: "an Alt-click leaves the panel open..."
   *     failed the same way for the Alt-click assertion.
   *   - `event.button === 0 &&` removed entirely (the three modifier-key
   *     conjuncts are each already 0 by default on every MouseEvent these
   *     tests construct without setting `button`, so removing only this
   *     clause isolates it from the others): "a middle-click (non-primary
   *     button)..." failed the same way for the middle-click assertion.
   * Each mutation left the rest of this file's tests, and the other three
   * new tests below, green - confirming each new test is tied to its own
   * clause, not to one shared failure mode.
   */
  it("a Ctrl-click leaves the panel open; a plain click on the same link still closes it", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    const link = panel()?.querySelector("a");
    expect(link, "no link found in the open panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
      );
    });
    expect(panel(), "a Ctrl-click closed the panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(panel(), "a plain click did not close the panel").toBeNull();
  });

  it("a Shift-click leaves the panel open; a plain click on the same link still closes it", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    const link = panel()?.querySelector("a");
    expect(link, "no link found in the open panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }),
      );
    });
    expect(panel(), "a Shift-click closed the panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(panel(), "a plain click did not close the panel").toBeNull();
  });

  it("an Alt-click leaves the panel open; a plain click on the same link still closes it", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    const link = panel()?.querySelector("a");
    expect(link, "no link found in the open panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, altKey: true }),
      );
    });
    expect(panel(), "an Alt-click closed the panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(panel(), "a plain click did not close the panel").toBeNull();
  });

  it("a middle-click (non-primary button) leaves the panel open; a plain click on the same link still closes it", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    const link = panel()?.querySelector("a");
    expect(link, "no link found in the open panel").not.toBeNull();

    act(() => {
      // `button: 1` is the middle mouse button - the one real-browser click
      // that (like Cmd/Ctrl/Shift/Alt) does not navigate in this tab, which
      // is what `event.button === 0` in isPlainLeftClick excludes.
      link?.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true, button: 1 }),
      );
    });
    expect(panel(), "a middle-click closed the panel").not.toBeNull();

    act(() => {
      link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(panel(), "a plain click did not close the panel").toBeNull();
  });

  /**
   * ugcportal-14k9 PR #94 review round 3 medium finding: the hand-rolled
   * `{open && <nav>...}` toggle this shipped with closed only on a second
   * click of the toggle button or on selecting a nav item - nothing
   * dismissed it on Escape, and nothing returned focus anywhere in
   * particular when it closed. `@base-ui/react/popover`'s own dismissal
   * model (Escape + outside-press, both wired by default, documented in
   * `PopoverRootChangeEventReason`) is what this test, and the one below
   * it, actually exercise - not a hand-rolled listener this component would
   * otherwise need to own and keep correct itself.
   */
  it("Escape closes the panel and returns focus to the toggle button", async () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    await flush();
    expect(panel(), "panel did not open").not.toBeNull();

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await flush();

    expect(panel()).toBeNull();
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggleButton());
  });

  /**
   * `.click()`, not a bare `pointerdown` (confirmed empirically, not
   * assumed): a click-opened Popover.Trigger puts the dismiss hook into
   * `outsidePressEvent: 'intentional'` mode, which requires a full outside
   * press-and-release (or a detail-0 "virtual" click, the same shape
   * `Element.prototype.click()` itself produces) before it dismisses - a
   * lone synthetic `pointerdown` is deliberately not enough on its own, so
   * that an outside drag that merely starts with a pointerdown cannot
   * dismiss the popup the instant it begins.
   */
  it("a click outside the panel closes it", async () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    await flush();
    expect(panel(), "panel did not open").not.toBeNull();

    act(() => {
      // Outside both the toggle button and the panel - document.body itself,
      // which neither element is.
      document.body.click();
    });
    await flush();

    expect(panel()).toBeNull();
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * ugcportal-14k9 PR #94 review round 4, finding 2: widening the viewport
   * from under `md` to at or above it, with the panel open, used to leave
   * BOTH this panel and site-header.tsx's always-visible desktop `<nav>`
   * carrying the landmark name "Main navigation" at once. Fired by hand via
   * the stubbed `matchMedia` above, since jsdom has no real viewport to
   * resize.
   */
  it("closes the panel on a matchMedia change reporting the viewport is now at or above md", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    expect(panel(), "panel did not open").not.toBeNull();
    expect(
      matchMediaChangeListener,
      "no matchMedia 'change' listener was registered while the panel was open",
    ).not.toBeNull();

    act(() => {
      matchMediaChangeListener?.({ matches: true } as MediaQueryListEvent);
    });

    expect(panel()).toBeNull();
    expect(toggleButton().getAttribute("aria-expanded")).toBe("false");
  });

  /**
   * ugcportal-14k9 PR #94 review round 5 finding 8: the effect's own cleanup
   * (`mediaQuery.removeEventListener("change", handleChange)`) is what
   * stops a STALE closure over an earlier `open`/`items` from firing after
   * the panel has closed, or after this component is gone entirely. Not
   * React's "Warning: Can't perform a state update on an unmounted
   * component" (round 6 finding 2: that warning was removed in React 18 and
   * this repo is on React 19 - it does not fire here or anywhere else in
   * this codebase). The real symptom of the leak: a later, wholly unrelated
   * viewport resize past `md` would still invoke the stale closure's
   * `setOpen(false)` - a silent no-op while mounted (there is nothing left
   * to dismiss), and on an unmounted component, state held by a fiber React
   * has already discarded, neither of which a user or a test would ever
   * observe directly. That invisibility is exactly why this is worth
   * testing explicitly rather than trusting "nothing crashed".
   */
  it("removes the matchMedia 'change' listener when the panel closes", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    expect(matchMediaChangeListener, "no listener registered while open").not.toBeNull();

    act(() => {
      toggleButton().click();
    });

    expect(matchMediaChangeListener, "listener was not removed on close").toBeNull();
  });

  it("removes the matchMedia 'change' listener on unmount", () => {
    act(() => {
      root.render(<MobileNavToggle items={ITEMS} />);
    });

    act(() => {
      toggleButton().click();
    });
    expect(matchMediaChangeListener, "no listener registered while open").not.toBeNull();

    act(() => {
      root.unmount();
    });

    expect(matchMediaChangeListener, "listener was not removed on unmount").toBeNull();
  });

  /**
   * ugcportal-i7lr K3: `children` is the slot site-header.tsx uses to pass
   * its own `<UploadNavLink />` into this panel's `<ul>`, so the mobile menu
   * carries the same upload entry the desktop `<nav>` does rather than
   * silently dropping it (see this component's own doc comment on the prop).
   * This proves the mechanism itself at runtime - that whatever is passed as
   * `children` actually lands inside the SAME `<ul>` the mapped `items` do,
   * positioned AFTER them - independent of SiteHeader/UploadNavLink, which
   * have their own dedicated test files.
   *
   * THE FIXTURE MUTATION: removed `{children}` from the `<ul>` in this
   * component's own source and reran this test by hand: the extra `<li>` was
   * never found in the panel (`extra` came back `null`), so the assertion
   * below failed as expected. Reverted immediately after.
   */
  it("K3: renders an extra child after the mapped items, inside the same panel list", () => {
    act(() => {
      root.render(
        <MobileNavToggle items={ITEMS}>
          <li data-testid="extra-item">
            <a href="/upload">Upload</a>
          </li>
        </MobileNavToggle>,
      );
    });

    act(() => {
      toggleButton().click();
    });

    const nav = panel();
    expect(nav, "panel did not open").not.toBeNull();
    const links = [...(nav?.querySelectorAll("a") ?? [])];
    expect(links.map((a) => a.textContent)).toEqual(["Gallery", "About", "Upload"]);

    const extra = nav?.querySelector('[data-testid="extra-item"]');
    expect(extra, "extra child not found in the panel").not.toBeNull();
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

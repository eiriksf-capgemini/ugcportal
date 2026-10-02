import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";

/**
 * ugcportal-rw9j round 5: e2e/petrol-theme.spec.ts's K1 test checks the
 * primary-button fill by proxy (the header's own bg-primary/text-primary-
 * foreground skip link, chosen because the gallery's only default-variant
 * Button is conditionally rendered and this repo has no e2e DB-seeding
 * infrastructure yet) rather than by rendering <Button variant="default">
 * itself. That proxy cannot see a regression in button.tsx's own variant
 * map - verified directly: reassigning the `default` variant's background
 * utility leaves the skip-link check, which duplicates the same two
 * utilities independently in app-shell.tsx, completely unaffected. This
 * test closes exactly that gap, cheaply and deterministically, by asserting
 * on the variant map itself rather than a rendered DOM node.
 */
describe("buttonVariants", () => {
  it("default variant fills with the primary petrol token and primary-foreground label", () => {
    // Split into individual class tokens rather than a substring `toContain`:
    // "bg-primary" is itself a substring of "hover:bg-primary-hover", so a
    // naive toContain("bg-primary") can never fail even with the resting
    // fill removed entirely - verified by mutating the fixture (temporarily
    // dropping "bg-primary" from the default variant left a substring
    // toContain check green).
    const classes = buttonVariants({ variant: "default" }).split(/\s+/);
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("text-primary-foreground");
  });
});

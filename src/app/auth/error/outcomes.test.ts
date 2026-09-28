import { describe, expect, it } from "vitest";

import { SITE_NAME } from "@/lib/site";

import { authErrorCopy, singleErrorParam } from "./outcomes";

/**
 * ugcportal-egp: a refused sign-in must be comprehensible and must not be a
 * dead end that offers the same refused journey again.
 */

describe("the Access Denied copy", () => {
  const copy = authErrorCopy("AccessDenied");

  it("says the instance is private and who to ask", () => {
    expect(copy.heading).toBe("Access denied");
    expect(copy.body.join(" ")).toContain(`${SITE_NAME} is a private instance`);
    expect(copy.body.join(" ")).toContain("ask whoever runs this site");
  });

  it("does not offer a retry", () => {
    // @auth/core's built-in page puts a Sign in button here, which restarts
    // the identical journey and gets the identical refusal. The default case
    // below DOES offer one, so this is not an assertion that always holds.
    expect(copy.offerRetry).toBe(false);
    expect(authErrorCopy(undefined).offerRetry).toBe(true);
  });

  it("does not disclose anything about the configuration", () => {
    const all = `${copy.heading} ${copy.body.join(" ")}`.toLowerCase();

    for (const leak of [
      "allowed_signin_emails",
      "admin_bootstrap_emails",
      "allowlist",
      "not on the list",
      "env",
      "unverified",
    ]) {
      expect(all).not.toContain(leak);
    }
  });

  it("does not claim the address is absent from a list", () => {
    // The gate refuses for four distinct reasons and only one of them is
    // "not listed" — copy that named that reason would be a claim the code
    // does not always support.
    expect(copy.body.join(" ")).toContain("this sign-in was not permitted");
  });
});

describe("the other auth errors", () => {
  it("does not blame the visitor for a server misconfiguration", () => {
    const copy = authErrorCopy("Configuration");

    expect(copy.heading).toBe("Sign-in is misconfigured");
    expect(copy.body.join(" ")).toContain("not with your account");
    // @auth/core substitutes Configuration for anything unsafe to disclose,
    // so this page genuinely does not know the cause and must not imply one.
    expect(copy.offerRetry).toBe(false);
  });

  it("offers a retry where retrying can work", () => {
    expect(authErrorCopy("Verification").offerRetry).toBe(true);
  });

  it("does not present a bare visit to the page as an error", () => {
    // Someone can simply navigate here. `?error` absent is not a refusal, so
    // the AccessDenied copy must not be the fallback.
    const copy = authErrorCopy(undefined);

    expect(copy.heading).not.toBe("Access denied");
    expect(copy.body.join(" ")).not.toContain("private instance");
  });

  it("gives every case its own heading", () => {
    const headings = [
      "AccessDenied",
      "Configuration",
      "Verification",
      undefined,
      "SomethingNewInAuthjs",
    ].map((error) => authErrorCopy(error).heading);

    // The last two share the fallback deliberately; the first three must not
    // collapse into each other.
    expect(new Set(headings).size).toBe(4);
  });
});

describe("singleErrorParam", () => {
  it("passes a single value through", () => {
    expect(singleErrorParam("AccessDenied")).toBe("AccessDenied");
    expect(singleErrorParam(undefined)).toBeUndefined();
  });

  it("takes the first of a repeated parameter", () => {
    // ?error=AccessDenied&error=Verification reaches a server component as an
    // array. Passing the array straight to authErrorCopy would fall to the
    // default and offer a retry link on a refusal, so the collapse happens
    // before the switch sees it.
    expect(singleErrorParam(["AccessDenied", "Verification"])).toBe(
      "AccessDenied",
    );
    expect(
      authErrorCopy(singleErrorParam(["AccessDenied", "Verification"]))
        .offerRetry,
    ).toBe(false);
  });

  it("does not turn an empty repeated parameter into a value", () => {
    expect(singleErrorParam([])).toBeUndefined();
  });
});

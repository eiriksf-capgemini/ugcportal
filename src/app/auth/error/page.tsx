import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { signInPath } from "@/lib/routes";

import { authErrorCopy, singleErrorParam } from "./outcomes";

export const metadata = {
  title: "Sign-in problem",
};

/**
 * Where a failed sign-in lands (ugcportal-egp).
 *
 * Wired as `pages.error` in src/lib/auth.ts, so it replaces @auth/core's
 * built-in error card for every auth error, not only the `AccessDenied` a
 * refused sign-in produces — hence the switch in ./outcomes rather than a
 * single hardcoded message.
 *
 * Renders for anyone, signed in or not, and MUST stay that way — an
 * invariant this repo keeps, not one @auth/core enforces. It never fetches
 * this page and cannot tell whether it is gated; its only related check
 * compares the request's `callbackUrl` query parameter against `pages.error`
 * (index.js:93-96) and runs only on the config-error branch. So adding
 * `await auth()` plus a redirect here would not be caught: it would loop a
 * refused visitor between this page and the sign-in they cannot complete.
 *
 * Note that merely CALLING `auth()` is not the hazard — the shell above this
 * page already does, in AuthStatus. Redirecting on its result is.
 *
 * It does not render the refusal reason, and there is nothing in the URL to
 * render: Auth.js puts only the error *type* in the query string, and every
 * refusal this app produces is the same type. Which addresses are permitted
 * is therefore not observable from here.
 */
export default async function AuthErrorPage(props: PageProps<"/auth/error">) {
  const { error } = await props.searchParams;
  const copy = authErrorCopy(singleErrorParam(error));

  return (
    <div className="mx-auto w-full max-w-xl px-4 py-24 sm:px-6">
      <h1 className="text-2xl font-medium tracking-tight text-foreground sm:text-3xl">
        {copy.heading}
      </h1>
      {copy.body.map((paragraph) => (
        <p
          key={paragraph}
          className="mt-4 max-w-prose text-sm text-muted-foreground"
        >
          {paragraph}
        </p>
      ))}

      <div className="mt-8 flex flex-wrap items-center gap-3">
        {/*
          Links carrying the button styling, rather than <Button> wrapping a
          link: these navigate, and a <button> that navigates is the wrong
          element for anyone using a keyboard or a screen reader. The variants
          are shared so it still looks like every other control.

          Home first, and the only destination offered on a refusal — a
          refused visitor has exactly one useful one, and it is not the
          sign-in page.
        */}
        <Link
          href="/"
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Back to home
        </Link>
        {copy.offerRetry && (
          <Link
            href={signInPath("/")}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            Try signing in again
          </Link>
        )}
      </div>
    </div>
  );
}

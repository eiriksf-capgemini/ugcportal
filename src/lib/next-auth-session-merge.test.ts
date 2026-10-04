import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE DEPENDENCY THE REFUSAL RESTS ON (PR #91 review, round 4, finding 1).
 *
 * `refusedSession` in src/lib/live-session.ts returns `{ expires, user:
 * undefined }` — a present-but-undefined `user` — and the reason it has to
 * be present at all is a line inside next-auth:
 *
 *   async session(...args) {
 *     const session = (await config.callbacks?.session?.(...args)) ?? {...}
 *     const user = args[0].user ?? args[0].token;
 *     return { user, ...session };
 *   }
 *
 * The spread puts this app's answer OVER the adapter user next-auth already
 * had. A returned object with no `user` key gets the whole `User` row put
 * back, id included, and the refusal becomes invisible: no error, no 401,
 * and a test that drove our callback directly would still pass. So the
 * refusal depends on a specific merge direction in a beta dependency, and
 * every test of it necessarily re-implements that merge rather than
 * executing it.
 *
 * WHY NOT EXECUTE IT. Driving the real thing needs
 * `next-auth/lib/index.js`, and it cannot be loaded here. Three separate
 * reasons, each sufficient, measured rather than assumed (2026-10-04):
 *
 *   1. next-auth's `package.json#exports` does not expose `./lib/index.js`,
 *      so vite refuses the specifier: `Missing "./lib/index.js" specifier`;
 *   2. importing the file by absolute path reaches Node's ESM resolver,
 *      which fails on next-auth's own extensionless `import "next/headers"`
 *      — Next ships no `exports` map, and `node_modules/next/headers` is
 *      only resolvable as `next/headers.js`;
 *   3. vitest externalises dependencies, so `vi.mock("next/headers")` never
 *      gets a chance to intercept: the failure above happens in Node, not
 *      in the module graph vitest controls.
 *
 * So the dependency is PINNED instead, and this file is the pin. `next-auth`
 * is an exact version in package.json — not a range — and the assertions
 * below read the installed source. An upgrade that moves the merge, or a
 * range that lets one arrive unannounced, fails here with a pointer to what
 * to re-verify, instead of silently turning every revoked session back into
 * a signed-in one.
 *
 * IF THIS FAILS AFTER AN UPGRADE: check `getSession` in
 * node_modules/next-auth/lib/index.js. If the merge still puts the
 * callback's answer last, update the expectation here. If it does not,
 * `refusedSession` is wrong and src/lib/live-session.ts must change —
 * src/lib/live-session.test.ts's "keeps the `user` key" case and
 * src/app/api/media/route.revocation.test.ts's `asAuthResolvesIt` both
 * model this line and must change with it.
 */

const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

const packageJson = JSON.parse(read("package.json")) as {
  dependencies: Record<string, string>;
};
const installed = JSON.parse(
  read("node_modules/next-auth/package.json"),
) as { version: string };
const nextAuthSource = read("node_modules/next-auth/lib/index.js");

describe("the next-auth session merge this app's refusal depends on", () => {
  it("still puts the callback's answer last, so an undefined user wins", () => {
    // The exact line. Not a looser match: `{ ...session, user }` — the same
    // tokens in the other order — would compile, read almost identically in
    // a diff, and quietly restore the user on every refused session.
    expect(nextAuthSource).toContain("return { user, ...session };");
  });

  it("still reaches that merge through the session callback", () => {
    // Guards the assertion above against passing on some unrelated line
    // that happens to spell the same thing: the merge has to be the return
    // of the wrapper that calls this app's `session` callback.
    const wrapper = nextAuthSource.slice(
      nextAuthSource.indexOf("async session(...args)"),
      nextAuthSource.indexOf("return { user, ...session };"),
    );
    expect(wrapper).not.toBe("");
    expect(wrapper).toContain("config.callbacks?.session?.(...args)");
  });

  it("is pinned to an exact version, so an upgrade cannot arrive unannounced", () => {
    const pinned = packageJson.dependencies["next-auth"];
    // No `^`, no `~`, no range: this dependency's internals are load-bearing
    // for an authorisation decision, which is a different relationship from
    // the rest of package.json.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    expect(installed.version).toBe(pinned);
  });
});

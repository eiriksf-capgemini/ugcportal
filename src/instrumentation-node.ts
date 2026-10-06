/**
 * Boot checks that only run, or only compile, under the Node runtime
 * (ugcportal-177y).
 *
 * Next compiles src/instrumentation.ts's `register()` for BOTH runtimes it
 * instruments — node and edge — because `register()` is the one hook Next
 * calls in each. A static import from that file reaches into both compiled
 * bundles, whatever the import is actually used for at runtime. This module
 * exists so the Node-only checks live somewhere a *static* import never
 * reaches: src/instrumentation.ts loads it with a dynamic `import()` gated
 * on `process.env.NEXT_RUNTIME === "nodejs"` (the pattern Next's own docs
 * recommend for this), so the edge compile never even asks for this file,
 * let alone bundles what it imports — see the K4 static-import-graph test
 * and the K1/K2 build and dev output checked in this PR for the evidence.
 *
 * `checkLegalPagesPublishable` is the reason this module needs to exist at
 * all: at the time of ugcportal-177y's investigation it (via
 * `@/lib/legal/pages` and `@/lib/legal/publishable`) was the only path from
 * src/instrumentation.ts to a Node built-in — `node:crypto`, used by
 * `authoredDigest` to hash each legal page's authored prose (bd notes on
 * ugcportal-177y; reconfirmed by the K4 test, which walks the whole graph
 * rather than trusting that investigation to still hold). That digest is
 * also called synchronously while building `LEGAL_PAGES` itself (consumed
 * by src/app/privacy/content.ts and src/app/licence/content.ts), so
 * replacing `createHash` with the async Web Crypto `subtle` digest would
 * ripple into both of those call sites instead of staying contained here —
 * moving the import, not the implementation, is the smaller change.
 */
import { LEGAL_PAGES } from "@/lib/legal/pages";
import { checkLegalPagesPublishable } from "@/lib/legal/publishable";

/**
 * Every boot check that belongs behind the Node-runtime guard. Called once
 * from src/instrumentation.ts's `register()`.
 */
export async function registerNodeOnlyChecks(): Promise<void> {
  for (const warning of [
    // ugcportal-qnq9.4: while a LEGAL_* variable is unset (env.example) the
    // legal pages refuse to render in production (src/lib/legal/
    // publishable.ts); say which at boot rather than leaving it to the
    // first visitor to find.
    checkLegalPagesPublishable(LEGAL_PAGES),
  ]) {
    if (warning) {
      console.error(warning);
    }
  }
}

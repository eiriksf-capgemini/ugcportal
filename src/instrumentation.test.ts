import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The committed users array is emptied for this file, for the same reason
 * src/lib/sign-in-policy.test.ts empties it: these are the tests for what
 * the sign-in ENV VARS report at boot, and with the real array unioned in
 * (ugcportal-t33p) "nobody can sign in" is never true. The array's own boot
 * check is `checkConfiguredUsers`, tested below against fixtures it is
 * handed directly, so this line hides nothing from it.
 */
vi.mock("@/config/users", () => ({ CONFIGURED_USERS: [] }));

/**
 * registerNodeOnlyChecks() (src/instrumentation-node.ts) now also probes
 * object storage at boot (ugcportal-ze1o). Every register()-level test in
 * THIS file predates that check and is not testing it, so the client is
 * mocked to answer immediately and successfully by default — real network
 * I/O in an unrelated unit test would be slow, flaky, and (in an environment
 * where S3_ENDPOINT happens to be configured) an actual connection attempt.
 * `checkS3Reachability` itself, with the `probe`/`env` it accepts as
 * parameters precisely so it does not need this, is tested directly in
 * src/instrumentation-node.test.ts.
 */
vi.mock("@/lib/s3", () => ({
  getS3Client: vi.fn(() => ({ send: vi.fn().mockResolvedValue({}) })),
  getBucketName: vi.fn(() => "test-bucket"),
  classifyTransportFailure: vi.fn(() => null),
}));

import {
  checkConfiguredUsers,
  checkContactEmailConfiguration,
  checkEvidenceEncryption,
  checkSignInConfiguration,
  register,
} from "@/instrumentation";
import { CONTACT_EMAIL_PLACEHOLDER } from "@/lib/contact";
import {
  FILLED_LEGAL_ENV,
  REPO_ROOT,
  stubLegalEnv,
} from "@/lib/legal/legal-page.test-support";
import { PERMITTED_EMAILS_VAR } from "@/lib/sign-in-policy";

const PROD = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

describe("the evidence-encryption startup check", () => {
  it("warns when production declares no encryption at all", () => {
    // The case the check exists for: a deployment provisioned from
    // env.example, where the variable is commented out, silently storing
    // contracts and model releases in the clear.
    const warning = checkEvidenceEncryption(PROD);

    expect(warning).toContain("WITHOUT server-side encryption");
    expect(warning).toContain("S3_EVIDENCE_SSE=AES256");
  });

  it("is quiet when the request header is configured", () => {
    expect(
      checkEvidenceEncryption({ ...PROD, S3_EVIDENCE_SSE: "AES256" }),
    ).toBeNull();
  });

  it("is quiet when the bucket encrypts everything and the operator says so", () => {
    // Bucket-level default encryption satisfies the same requirement and is
    // the better answer — it cannot be forgotten per-request.
    expect(
      checkEvidenceEncryption({
        ...PROD,
        S3_EVIDENCE_ENCRYPTED_AT_BUCKET: "true",
      }),
    ).toBeNull();
  });

  it("still warns on a value that rights-evidence would ignore", () => {
    // Only the exact "AES256" is sent as a header, so a typo means no
    // encryption — and the warning has to agree with that, not with the
    // operator's intent.
    expect(
      checkEvidenceEncryption({ ...PROD, S3_EVIDENCE_SSE: "aes256" }),
    ).not.toBeNull();
  });

  it("says nothing outside production", () => {
    // Dev runs against a KMS-less MinIO; warning there would train people
    // to ignore it.
    expect(checkEvidenceEncryption({ NODE_ENV: "development" })).toBeNull();
    expect(checkEvidenceEncryption({ NODE_ENV: "test" })).toBeNull();
  });
});

/**
 * ugcportal-egp: sign-in is refused by default, which is the correct default
 * and the wrong thing to be quiet about. Both configuration states that
 * permit nobody are announced before the first request.
 */
describe("the sign-in configuration startup check", () => {
  it("says loudly that nobody can sign in when nothing is configured", () => {
    const warning = checkSignInConfiguration({ NODE_ENV: "production" });

    expect(warning).toContain("NOBODY can sign in");
    expect(warning).toContain(PERMITTED_EMAILS_VAR);
    expect(warning).toContain("docs/access-control.md");
  });

  it("is quiet once an address is permitted", () => {
    // The needle-can-be-absent control for every case in this block.
    expect(
      checkSignInConfiguration({
        [PERMITTED_EMAILS_VAR]: "owner@example.com",
      }),
    ).toBeNull();
  });

  it("is quiet when only the bootstrap variable is set", () => {
    // A fresh deployment following env.example's ugcportal-lu7 instructions
    // is configured, not broken.
    expect(
      checkSignInConfiguration({ ADMIN_BOOTSTRAP_EMAILS: "admin@example.com" }),
    ).toBeNull();
  });

  it("explains the provider prefix when an entry cannot be used (ugcportal-1551)", () => {
    const message = checkSignInConfiguration({
      ALLOWED_SIGNIN_EMAILS: "twitter:someone@example.com",
    });
    expect(message).toContain("twitter:someone@example.com");
    expect(message).toContain("google:");
    expect(message).toContain("facebook:");
    expect(message).toContain("NOBODY can sign in");
  });

  it("names an entry it cannot use rather than silently permitting nobody", () => {
    // The more dangerous of the two quiet states: `*@example.com` reads like
    // it works, and would otherwise look configured while permitting nobody.
    const warning = checkSignInConfiguration({
      [PERMITTED_EMAILS_VAR]: "*@example.com",
    });

    expect(warning).toContain("*@example.com");
    expect(warning).toContain("wildcards and domain patterns are not supported");
    expect(warning).toContain("NOBODY can sign in");
  });

  it("reports a partly-usable list without claiming nobody can sign in", () => {
    // The claim has to match the situation: one bad entry alongside a good
    // one is worth reporting, but "NOBODY can sign in" would be false.
    const warning = checkSignInConfiguration({
      [PERMITTED_EMAILS_VAR]: "nobody, owner@example.com",
    });

    expect(warning).toContain("nobody");
    expect(warning).not.toContain("NOBODY can sign in");
    expect(warning).toContain("1 address(es) remain permitted");
  });

  it("warns outside production too", () => {
    // Unlike the encryption check above: a fresh local checkout is exactly
    // where this is hit first, and env.example ships the variable empty.
    expect(checkSignInConfiguration({ NODE_ENV: "development" })).toContain(
      "NOBODY can sign in",
    );
    expect(checkSignInConfiguration({})).toContain("NOBODY can sign in");
  });
});

/**
 * ugcportal-t33p, scope item 5: the committed users array is checked at boot
 * too, and separately from the env vars above, because its mistakes are a
 * different kind of problem with a different fix.
 *
 * The rule lives in `configuredUserProblems` and has its own tests in
 * src/lib/configured-users.test.ts. What is asserted here is that the boot
 * hook exposes it and reports each of the four shapes the bead names — an
 * identity under two users, an unknown provider, a user with no identities,
 * and a malformed identity — as its own line. The fixtures are handed in
 * directly, so this does not depend on what the real array happens to say.
 */
describe("the configured-users startup check", () => {
  it("is quiet for a sound array", () => {
    expect(
      checkConfiguredUsers([
        { name: "Ada", identities: ["google:ada@example.com"] },
      ]),
    ).toEqual([]);
  });

  it("reports each of the four problems as its own line", () => {
    const problems = checkConfiguredUsers([
      { name: "Ada", identities: ["google:shared@example.com"] },
      { name: "Grace", identities: ["google:shared@example.com"] },
      { name: "Edsger", identities: ["twitter:edsger@example.com"] },
      { name: "Nobody", identities: [] },
      { name: "Alan", identities: ["google:*@example.com"] },
    ] as unknown as Parameters<typeof checkConfiguredUsers>[0]);

    // One line each — folding them into one string is how three get missed.
    expect(problems).toHaveLength(4);
    expect(problems.filter((line) => line.includes("more than one"))).toHaveLength(1);
    expect(
      problems.filter((line) => line.includes("names no known provider")),
    ).toHaveLength(1);
    expect(problems.filter((line) => line.includes("has no identities"))).toHaveLength(1);
    expect(
      problems.filter((line) => line.includes("not one exact email address")),
    ).toHaveLength(1);
  });

  it("names the file to edit on every line", () => {
    // Every other check in this file points at env.example; this one has to
    // point at the module, or the operator has nowhere to go.
    const problems = checkConfiguredUsers([
      { name: "Nobody", identities: [] },
      { name: "Alan", identities: ["google:*@example.com"] },
    ]);

    expect(problems).toHaveLength(2);
    for (const problem of problems) {
      expect(problem).toContain("src/config/users.ts");
      expect(problem.startsWith("[auth]")).toBe(true);
    }
  });
});

/**
 * ugcportal-qnq9.7 round-1 review: moved out of src/lib/contact.ts's own
 * `resolveContactEmail`, which used to throw at render time. Same shape as
 * the two checks above — a warning at boot, not a refusal to boot.
 */
describe("the contact-email startup check", () => {
  it("warns when production has nothing configured", () => {
    const warning = checkContactEmailConfiguration({
      NODE_ENV: "production",
    } as NodeJS.ProcessEnv);

    expect(warning).toContain("CONTACT_EMAIL is not set");
    expect(warning).toContain(CONTACT_EMAIL_PLACEHOLDER);
    expect(warning).toContain("env.example");
  });

  it("warns when production's CONTACT_EMAIL is whitespace-only", () => {
    expect(
      checkContactEmailConfiguration({
        NODE_ENV: "production",
        CONTACT_EMAIL: "   ",
      } as NodeJS.ProcessEnv),
    ).toContain("CONTACT_EMAIL is not set");
  });

  it("is quiet once a real address is configured", () => {
    expect(
      checkContactEmailConfiguration({
        NODE_ENV: "production",
        CONTACT_EMAIL: "owner@example.com",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("says nothing outside production when simply unset", () => {
    // Local dev and CI never set CONTACT_EMAIL; warning there would train
    // people to ignore it, same reasoning as the evidence-encryption check.
    expect(
      checkContactEmailConfiguration({ NODE_ENV: "development" } as NodeJS.ProcessEnv),
    ).toBeNull();
    expect(
      checkContactEmailConfiguration({ NODE_ENV: "test" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  // Round-2 review: a malformed value is a real mistake the moment it is
  // made, so — unlike "simply unset" above — this is flagged in every
  // environment, the same way the sign-in check's own malformed-entry case
  // is unconditional.
  describe("rejects anything that is not a bare address", () => {
    it('warns on "Name <addr>" even outside production', () => {
      const warning = checkContactEmailConfiguration({
        NODE_ENV: "development",
        CONTACT_EMAIL: "Jane Doe <jane@example.com>",
      } as NodeJS.ProcessEnv);

      expect(warning).toContain("not a");
      expect(warning).toContain("bare email address");
      expect(warning).toContain("Jane Doe <jane@example.com>");
    });

    it("warns on a value containing any whitespace", () => {
      expect(
        checkContactEmailConfiguration({
          NODE_ENV: "development",
          CONTACT_EMAIL: "jane doe@example.com",
        } as NodeJS.ProcessEnv),
      ).toContain("bare email address");
    });

    it("still warns in production, in place of the usual 'is not set' message", () => {
      const warning = checkContactEmailConfiguration({
        NODE_ENV: "production",
        CONTACT_EMAIL: "Jane Doe <jane@example.com>",
      } as NodeJS.ProcessEnv);

      expect(warning).toContain("bare email address");
      expect(warning).not.toContain("CONTACT_EMAIL is not set");
    });

    it("is quiet for an ordinary bare address", () => {
      expect(
        checkContactEmailConfiguration({
          NODE_ENV: "development",
          CONTACT_EMAIL: "jane@example.com",
        } as NodeJS.ProcessEnv),
      ).toBeNull();
    });
  });
});

/**
 * ugcportal-qnq9.4: the legal-page placeholder check is wired into boot.
 * The check itself is tested in src/lib/legal/publishable.test.ts; this
 * proves register() actually calls it, in whichever state the repository's
 * contact block is in.
 *
 * ugcportal-177y moved this check behind a dynamic import gated on
 * `NEXT_RUNTIME === "nodejs"` (src/instrumentation-node.ts), so every test
 * here that expects the check to run stubs that variable the same way Next
 * sets it for the real node compile.
 */
describe("the legal-pages startup check", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function legalLinesFromBoot(): Promise<string[]> {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await register();
    return errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[legal]"));
  }

  it("names an unset LEGAL_* variable at boot, in production and out", async () => {
    stubLegalEnv("production", { ...FILLED_LEGAL_ENV, LEGAL_CONTROLLER_NAME: "" });
    const inProduction = await legalLinesFromBoot();
    expect(inProduction.join("\n")).toContain("LEGAL_CONTROLLER_NAME is not set");
    expect(inProduction.join("\n")).toContain("Production will not serve");

    stubLegalEnv("development", { ...FILLED_LEGAL_ENV, LEGAL_CONTROLLER_NAME: "" });
    const inDevelopment = await legalLinesFromBoot();
    expect(inDevelopment.join("\n")).toContain("LEGAL_CONTROLLER_NAME is not set");
    expect(inDevelopment.join("\n")).not.toContain("Production will not serve");
  });

  it("is quiet once every variable is set", async () => {
    stubLegalEnv("production", FILLED_LEGAL_ENV);
    expect(await legalLinesFromBoot()).toEqual([]);
  });

  it("does not run this check at all outside the node runtime (ugcportal-177y)", async () => {
    // The needle-can-be-absent control for every "names an unset..." test
    // above: with the same blocked configuration, but NEXT_RUNTIME left as
    // Next sets it for the edge compile, the dynamic import in register()
    // must never fire and this file must log nothing.
    stubLegalEnv("production", { ...FILLED_LEGAL_ENV, LEGAL_CONTROLLER_NAME: "" });
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await register();
    const legalLines = errors.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("[legal]"));
    expect(legalLines).toEqual([]);
  });
});

/**
 * K3 (ugcportal-177y): moving the legal-pages check behind the
 * NEXT_RUNTIME guard must not silently drop any of the OTHER boot checks
 * that were never part of the problem. This drives four of register()'s
 * five warning branches at once, under the runtime value Next actually
 * sets for the compile that really executes at startup, and asserts they
 * all still speak.
 *
 * The fifth, `checkConfiguredUsers`, cannot be exercised from THIS test:
 * this file mocks `@/config/users` to an empty array (see the top of this
 * file), and an empty array produces no problems for `checkConfiguredUsers`
 * to report regardless of whether `register()` still calls it. Its wiring
 * into `register()` is proven separately by
 * src/instrumentation.configured-users.test.ts, which mocks a users array
 * with real problems in its own module registry — a second file, not a
 * second describe block here, because the array is a module-level constant
 * and a single registry can only mock it one way (see that file's own doc
 * comment).
 */
describe("register() under the node runtime (ugcportal-177y, K3)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("still runs four of the five pre-existing boot checks when NEXT_RUNTIME is nodejs (the fifth is covered elsewhere, see the describe-level comment)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv(PERMITTED_EMAILS_VAR, "");
    vi.stubEnv("ADMIN_BOOTSTRAP_EMAILS", "");
    vi.stubEnv("CONTACT_EMAIL", "");
    vi.stubEnv("S3_EVIDENCE_SSE", "");
    vi.stubEnv("S3_EVIDENCE_ENCRYPTED_AT_BUCKET", "");
    stubLegalEnv("production", { ...FILLED_LEGAL_ENV, LEGAL_CONTROLLER_NAME: "" });

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await register();
    const lines = errors.mock.calls.map((call) => String(call[0]));

    expect(lines.some((line) => line.includes("WITHOUT server-side encryption"))).toBe(
      true,
    );
    expect(lines.some((line) => line.includes("NOBODY can sign in"))).toBe(true);
    expect(lines.some((line) => line.includes("CONTACT_EMAIL is not set"))).toBe(true);
    expect(lines.some((line) => line.startsWith("[legal]"))).toBe(true);
  });
});

/**
 * K4 (ugcportal-177y): "Following should never happen: a Node built-in
 * reaching the Edge Instrumentation bundle again." This walks
 * src/instrumentation.ts's STATIC import graph — the modules reachable
 * without a dynamic `import()` — and asserts none of them has a static
 * import of a Node built-in, bare (`"crypto"`) or `node:`-prefixed
 * (`"node:crypto"`); nothing in this repo's eslint config enforces the
 * prefix, so a regression could reintroduce the bare form just as easily as
 * the prefixed one.
 *
 * This is a CONSERVATIVE over-approximation of what Next actually bundles
 * for the edge compile, not an exact match: it walks every module reachable
 * through an ordinary static VALUE import or re-export, which can visit a
 * module Next's own tree-shaking would otherwise drop. `import type` /
 * `export type` declarations are excluded — the compiler erases them before
 * Next ever bundles anything, so counting them would only inflate false
 * positives (the repo's own `import type { LegalPage } from
 * "@/lib/legal/publishable"` at src/lib/legal/pages.ts:3 is exactly this
 * shape) without protecting against a real one. A bare package specifier
 * (`next`, `@aws-sdk/...`) is treated as an external dependency and not
 * walked into: this repository's own source is what the investigation
 * actually checked — `bd show ugcportal-177y` confirms `@/config/users`,
 * `@/lib/contact`, `@/lib/sign-in-policy`, `@/lib/legal/contact` and
 * `@/lib/email-shape` import nothing from `node:*` — not node_modules.
 *
 * The walker uses the TypeScript compiler's own AST (`ts.isImportDeclaration`
 * / `ts.isExportDeclaration`) rather than a regex, specifically so a dynamic
 * `import(...)` call expression — a different AST node entirely — is never
 * mistaken for a static one. The control tests below exercise that
 * distinction, the bare-vs-prefixed builtin classification, and the
 * type-only exclusion directly against fixtures, so a regression in any of
 * the three is caught here, not only by the real-file test going green for
 * the wrong reason.
 */
describe("the edge-safe static import graph (ugcportal-177y, K4)", () => {
  function staticImportSpecifiers(source: string, fileName: string): string[] {
    const sourceFile = ts.createSourceFile(
      fileName,
      source,
      ts.ScriptTarget.Latest,
      true,
      fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const specifiers: string[] = [];
    function visit(node: ts.Node) {
      if (
        ts.isImportDeclaration(node) &&
        !node.importClause?.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (
        ts.isExportDeclaration(node) &&
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return specifiers;
  }

  /**
   * A Node built-in can be named either way — `"crypto"` or
   * `"node:crypto"` — and both reach the same module. `node:module`'s own
   * `builtinModules` list is the bare-name source of truth; the `node:`
   * prefix check stays alongside it rather than being subsumed by it
   * because `builtinModules` does not itself list the prefixed form for
   * every entry.
   */
  const NODE_BUILTIN_NAMES = new Set(builtinModules);

  function isNodeBuiltinSpecifier(specifier: string): boolean {
    return specifier.startsWith("node:") || NODE_BUILTIN_NAMES.has(specifier);
  }

  const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

  function resolveOwnSourceFile(specifier: string, fromFile: string): string | null {
    let basePath: string;
    if (specifier.startsWith(".")) {
      basePath = path.resolve(path.dirname(fromFile), specifier);
    } else if (specifier.startsWith("@/")) {
      basePath = path.join(REPO_ROOT, "src", specifier.slice(2));
    } else {
      // An external package (e.g. "next", "@aws-sdk/client-s3") — not this
      // repository's own source, so not walked into. See the describe-level
      // doc comment for why.
      return null;
    }
    for (const ext of RESOLVABLE_EXTENSIONS) {
      try {
        readFileSync(basePath + ext, "utf8");
        return basePath + ext;
      } catch {
        // try the next extension
      }
    }
    for (const ext of RESOLVABLE_EXTENSIONS) {
      try {
        readFileSync(path.join(basePath, "index" + ext), "utf8");
        return path.join(basePath, "index" + ext);
      } catch {
        // try the next extension
      }
    }
    try {
      readFileSync(basePath, "utf8");
      return basePath;
    } catch {
      return null;
    }
  }

  /**
   * `readSource` is injectable (defaulting to the real filesystem) so a
   * test can hand the walker a virtual file map instead of writing to disk
   * — see the bare-builtin fixture test below, which is the only caller
   * that overrides it.
   */
  function walkStaticImportGraph(
    entryFile: string,
    readSource: (file: string) => string = (file) => readFileSync(file, "utf8"),
  ): {
    visited: string[];
    nodeBuiltins: { file: string; specifier: string }[];
  } {
    const visited = new Set<string>();
    const nodeBuiltins: { file: string; specifier: string }[] = [];
    const queue = [entryFile];
    while (queue.length > 0) {
      const file = queue.shift();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      const source = readSource(file);
      for (const specifier of staticImportSpecifiers(source, file)) {
        if (isNodeBuiltinSpecifier(specifier)) {
          nodeBuiltins.push({ file, specifier });
          continue;
        }
        const resolved = resolveOwnSourceFile(specifier, file);
        if (resolved && !visited.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
    return { visited: Array.from(visited), nodeBuiltins };
  }

  it("flags a direct static import of a node:-prefixed builtin (control)", () => {
    const specifiers = staticImportSpecifiers(
      'import { createHash } from "node:crypto";\n',
      "virtual.ts",
    );
    expect(specifiers).toContain("node:crypto");
  });

  it("does not see a dynamic import() call at all (control)", () => {
    // This is the exact shape ugcportal-177y's fix relies on: if the walker
    // ever started treating a dynamic import like a static one, this test
    // would fail and the real-file test below would start failing too, for
    // the right reason — not pass vacuously.
    const specifiers = staticImportSpecifiers(
      'async function f() { const mod = await import("node:crypto"); return mod; }\n',
      "virtual.ts",
    );
    expect(specifiers).not.toContain("node:crypto");
  });

  it("does not collect a type-only import's specifier (control)", () => {
    // The shape src/lib/legal/pages.ts:3 actually has:
    // `import type { LegalPage } from "@/lib/legal/publishable"`. The
    // compiler erases this before Next ever bundles anything, so it must
    // not count as a static edge the walk follows — fixture-mutated below
    // by checking the same specifier DOES get collected without the
    // `type` keyword.
    const typeOnly = staticImportSpecifiers(
      'import type { Hash } from "node:crypto";\n',
      "virtual.ts",
    );
    expect(typeOnly).not.toContain("node:crypto");

    const value = staticImportSpecifiers(
      'import { createHash } from "node:crypto";\n',
      "virtual.ts",
    );
    expect(value).toContain("node:crypto");
  });

  it("treats a bare builtin specifier as a hit too, not only the node:-prefixed form (fixture)", () => {
    const entry = "/virtual/entry.ts";
    const files = new Map<string, string>([
      [entry, 'import { createHash } from "crypto";\n'],
    ]);
    const { nodeBuiltins } = walkStaticImportGraph(entry, (file) => {
      const content = files.get(file);
      if (content === undefined) {
        throw new Error(`no such virtual file: ${file}`);
      }
      return content;
    });

    expect(nodeBuiltins).toEqual([{ file: entry, specifier: "crypto" }]);
  });

  it("never reaches a node: builtin from src/instrumentation.ts's static imports", () => {
    const entry = path.join(REPO_ROOT, "src", "instrumentation.ts");
    const { visited, nodeBuiltins } = walkStaticImportGraph(entry);

    expect(nodeBuiltins).toEqual([]);
    // Not vacuous: `resolveOwnSourceFile` swallows every resolution
    // failure as `null`, so a resolver
    // regression that silently dropped most `@/` specifiers would still
    // leave `nodeBuiltins` empty — for the wrong reason — and
    // `visited.length > 1` alone would not catch it. Asserting the exact
    // resolved set does: it fails the moment the walk stops reaching a
    // module it should.
    expect(new Set(visited)).toEqual(
      new Set([
        entry,
        path.join(REPO_ROOT, "src", "config", "users.ts"),
        path.join(REPO_ROOT, "src", "lib", "contact.ts"),
        path.join(REPO_ROOT, "src", "lib", "sign-in-policy.ts"),
        path.join(REPO_ROOT, "src", "lib", "email-shape.ts"),
      ]),
    );
  });
});

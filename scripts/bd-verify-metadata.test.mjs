/**
 * Tests for the bd write read-back verifier (ugcportal-kssp, mitigation 3).
 *
 * K3's "Verified by" asks for a deliberate failure injection showing the
 * read-back catches a write that did not land. That is the
 * "catches a write that did not land" test below: the bead read back is a
 * real `bd show --json` payload in which the write simply is not present,
 * and the verifier exits 1 and names the key. Two neighbouring injections
 * cover the two ways the v0.7.0 instances actually failed -- a key written
 * under a mistyped name (so the intended key is ABSENT while a sibling key
 * holds the value) and a note replaced wholesale by `--notes` instead of
 * `--append-notes`.
 */
import { describe, expect, it } from "vitest";

import {
  EXIT_MISMATCH,
  EXIT_OK,
  EXIT_UNREADABLE,
  EXIT_USAGE,
  checkExpectations,
  formatReport,
  main,
  parseArgs,
  selectBead,
} from "./bd-verify-metadata.mjs";

/** A `bd show <id> --json` payload, trimmed to the fields this tool reads. */
function bdShowJson(overrides = {}) {
  return JSON.stringify([
    {
      id: "ugcportal-kssp",
      title: "a bead",
      notes: "Premise verified 2026-10-12: still true at origin/main 0a9e051.",
      metadata: { cc_type: "chore", cc_scope: "process", model: "sonnet" },
      ...overrides,
    },
  ]);
}

/** Collects what a `main()` run printed, so a test can assert on the report itself. */
function run(argv, stdout) {
  const out = [];
  const errs = [];
  const code = main(argv, { read: () => stdout, log: (l) => out.push(l), err: (l) => errs.push(l) });
  return { code, out: out.join("\n"), errs: errs.join("\n") };
}

describe("parseArgs", () => {
  it("splits each expectation on the FIRST = so a value containing = survives", () => {
    const { id, expectations } = parseArgs(["ugcportal-kssp", "model_why=money=the expensive failure"]);
    expect(id).toBe("ugcportal-kssp");
    expect(expectations).toEqual([{ kind: "metadata", key: "model_why", value: "money=the expensive failure" }]);
  });

  it("understands notes~= as a contains check on the notes field", () => {
    expect(parseArgs(["b-1", "notes~=Premise verified"]).expectations).toEqual([
      { kind: "notes-contains", key: "notes", value: "Premise verified" },
    ]);
  });

  it("refuses a run with zero expectations rather than vacuously passing", () => {
    // The whole file in one assertion: a verifier handed nothing to verify
    // must not be able to print a success line.
    expect(() => parseArgs(["ugcportal-kssp"])).toThrow(/nothing to verify is a usage error, not a pass/);
  });

  it("refuses a malformed expectation instead of ignoring it", () => {
    expect(() => parseArgs(["b-1", "cc_type"])).toThrow(/malformed expectation/);
    expect(() => parseArgs(["b-1", "=value"])).toThrow(/malformed expectation/);
    expect(() => parseArgs(["b-1", "notes~="])).toThrow(/empty expectation/);
  });

  it("refuses a missing bead id", () => {
    expect(() => parseArgs([])).toThrow(/usage:/);
    expect(() => parseArgs(["--json", "cc_type=chore"])).toThrow(/usage:/);
  });
});

describe("selectBead", () => {
  it("finds the bead inside the array bd show --json returns", () => {
    expect(selectBead(bdShowJson(), "ugcportal-kssp").metadata.cc_type).toBe("chore");
  });

  it("throws on an empty array rather than treating 'no bead' as 'no problem'", () => {
    expect(() => selectBead("[]", "ugcportal-kssp")).toThrow(/returned no bead with that id \(got: <empty array>\)/);
  });

  it("throws when bd answered about some OTHER bead", () => {
    expect(() => selectBead(bdShowJson({ id: "ugcportal-zzzz" }), "ugcportal-kssp")).toThrow(/got: ugcportal-zzzz/);
  });

  it("throws on output that is not JSON at all", () => {
    expect(() => selectBead("issue not found\n", "b-1")).toThrow(/did not return JSON/);
  });
});

describe("checkExpectations", () => {
  const bead = JSON.parse(bdShowJson())[0];

  it("passes a key that holds exactly the written value", () => {
    expect(checkExpectations(bead, [{ kind: "metadata", key: "cc_type", value: "chore" }])).toEqual([
      { verdict: "ok", key: "cc_type", expected: "chore", actual: "chore" },
    ]);
  });

  it("distinguishes ABSENT from MISMATCH, because they point at different mistakes", () => {
    const results = checkExpectations(bead, [
      { kind: "metadata", key: "released_in", value: "v0.7.0" },
      { kind: "metadata", key: "cc_type", value: "feat" },
    ]);
    expect(results[0].verdict).toBe("ABSENT");
    expect(results[1].verdict).toBe("MISMATCH");
    expect(results[1].actual).toBe("chore");
  });

  it("compares a numeric metadata value as its string form rather than failing on the type", () => {
    const numeric = { metadata: { tokens_qa: 107768 } };
    expect(checkExpectations(numeric, [{ kind: "metadata", key: "tokens_qa", value: "107768" }])[0].verdict).toBe("ok");
  });

  it("checks notes~= as containment, and fails when the substring is gone", () => {
    expect(checkExpectations(bead, [{ kind: "notes-contains", key: "notes", value: "Premise verified" }])[0].verdict).toBe("ok");
    expect(checkExpectations(bead, [{ kind: "notes-contains", key: "notes", value: "round 4 finding" }])[0].verdict).toBe("MISMATCH");
  });
});

describe("formatReport", () => {
  const bead = JSON.parse(bdShowJson())[0];

  it("prints the bead's whole metadata keyset as the denominator, not only the keys asked about", () => {
    const text = formatReport("ugcportal-kssp", bead, checkExpectations(bead, [{ kind: "metadata", key: "cc_type", value: "chore" }])).join(
      "\n",
    );
    expect(text).toContain("read back 3 metadata key(s) [cc_scope, cc_type, model]; checked 1 expectation(s).");
    expect(text).toContain("VERIFIED: 1/1 expectation(s) landed");
  });

  it("does not say VERIFIED when something did not land", () => {
    const results = checkExpectations(bead, [{ kind: "metadata", key: "released_in", value: "v0.7.0" }]);
    const text = formatReport("ugcportal-kssp", bead, results).join("\n");
    expect(text).not.toContain("VERIFIED:");
    expect(text).toContain("FAILED: 1 of 1 expectation(s) did not land");
  });
});

describe("main (deliberate failure injections — K3)", () => {
  it("exits 0 and says VERIFIED when the write really landed", () => {
    const { code, out } = run(["ugcportal-kssp", "cc_type=chore", "cc_scope=process"], bdShowJson());
    expect(code).toBe(EXIT_OK);
    expect(out).toContain("VERIFIED: 2/2 expectation(s) landed on ugcportal-kssp.");
  });

  it("catches a write that did not land: the key is simply absent", () => {
    // The injection: the caller believes `bd update --set-metadata
    // released_in=v0.7.0` succeeded. The bead read back does not have it.
    const { code, out } = run(["ugcportal-kssp", "released_in=v0.7.0"], bdShowJson());
    expect(code).toBe(EXIT_MISMATCH);
    expect(out).toContain("ABSENT released_in: expected v0.7.0, bead holds <key not present on the bead>");
    expect(out).toContain("The write did not do what was reported.");
  });

  it("catches the mistyped-key instance: the value landed, under the wrong name", () => {
    // `--set-metadata relesed_in=...` exits 0 and writes a real key. The
    // intended key is absent; the typo is visible in the printed keyset
    // right beside it.
    const { code, out } = run(["ugcportal-kssp", "released_in=v0.7.0"], bdShowJson({ metadata: { relesed_in: "v0.7.0" } }));
    expect(code).toBe(EXIT_MISMATCH);
    expect(out).toContain("[relesed_in]");
    expect(out).toContain("ABSENT released_in");
  });

  it("catches a note destroyed by --notes where --append-notes was meant", () => {
    const { code, out } = run(["ugcportal-kssp", "notes~=Premise verified"], bdShowJson({ notes: "round 2 fix applied" }));
    expect(code).toBe(EXIT_MISMATCH);
    expect(out).toContain('MISMATCH notes: expected contains "Premise verified"');
  });

  it("exits 3, not 1, when the bead could not be read back at all", () => {
    const { code, out, errs } = run(["ugcportal-kssp", "cc_type=chore"], "[]");
    expect(code).toBe(EXIT_UNREADABLE);
    expect(out).toBe("");
    expect(errs).toContain("is UNVERIFIED");
  });

  it("exits 2 and prints no report when handed nothing to verify", () => {
    const { code, out, errs } = run(["ugcportal-kssp"], bdShowJson());
    expect(code).toBe(EXIT_USAGE);
    expect(out).toBe("");
    expect(errs).toContain("nothing to verify is a usage error, not a pass");
  });

  it("surfaces bd's own stderr instead of swallowing it", () => {
    const out = [];
    const errs = [];
    const code = main(["ugcportal-kssp", "cc_type=chore"], {
      read: () => {
        throw new Error("bd show ugcportal-kssp --json failed: database is locked");
      },
      log: (l) => out.push(l),
      err: (l) => errs.push(l),
    });
    expect(code).toBe(EXIT_UNREADABLE);
    expect(errs.join("\n")).toContain("database is locked");
  });
});

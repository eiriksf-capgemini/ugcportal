/**
 * Gating tests for .github/workflows/ci.yml (ugcportal-hwpc).
 *
 * The originating defect: `on.pull_request.branches: [main]` matches a PR's
 * *base* branch, so a PR stacked on another PR's branch fired no workflow at
 * all. When its base PR merged, GitHub retargeted it to main, which arrives
 * as a `pull_request` `edited` event -- and the quality job skipped every
 * `edited` event. The PR could therefore reach main showing a green check
 * having never run lint, test, typecheck or build.
 *
 * Two separate conditions in that file now encode the same predicate with
 * opposite polarity:
 *
 *   - the quality job's `if:`        -> does this event run the suite?
 *   - the concurrency group suffix   -> does this run carry a quality result?
 *
 * They are written out twice because GitHub Actions has no way to share one
 * expression between `concurrency:` (evaluated before any job starts, where
 * the `env` context is unavailable) and a job-level `if:`. Duplicated
 * conditions drift. The `stays the inverse of` test below is the guard
 * against that: it evaluates both, against the same payloads, and fails if
 * they ever disagree.
 *
 * WHAT THIS TEST IS, AND IS NOT. `evaluate()` is a local model of the subset
 * of GitHub's expression syntax ci.yml actually uses -- it is not GitHub's
 * evaluator, and it cannot prove GitHub fires the events these payloads
 * represent. That half was established by observation on a real PR and is
 * recorded on the bead. What this test does prove is that the two
 * expressions in the file keep agreeing, and that a title or body edit still
 * skips the suite (ugcportal-0an4) in a group of its own (ugcportal-sxwb).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../.github/workflows/ci.yml", import.meta.url),
);
const workflow = readFileSync(WORKFLOW_PATH, "utf8");

// --------------------------------------------------------------------------
// A small evaluator for the GitHub expression subset used by ci.yml:
// `||`, `&&`, `==`, `!=`, parentheses, single-quoted strings, `null`, and
// dotted context paths. Property access on a missing or null value yields
// null, as GitHub's does, so `github.event.changes.base` is safe to write on
// an event that carries no `changes` object at all.
// --------------------------------------------------------------------------

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === " ") {
      i += 1;
    } else if (source.startsWith("||", i) || source.startsWith("&&", i)) {
      tokens.push({ type: source.slice(i, i + 2) });
      i += 2;
    } else if (source.startsWith("==", i) || source.startsWith("!=", i)) {
      tokens.push({ type: source.slice(i, i + 2) });
      i += 2;
    } else if (ch === "(" || ch === ")") {
      tokens.push({ type: ch });
      i += 1;
    } else if (ch === "'") {
      const end = source.indexOf("'", i + 1);
      if (end === -1) throw new Error(`unterminated string in: ${source}`);
      tokens.push({ type: "value", value: source.slice(i + 1, end) });
      i = end + 1;
    } else if (/[A-Za-z0-9_.-]/.test(ch)) {
      let end = i;
      while (end < source.length && /[A-Za-z0-9_.[\]-]/.test(source[end])) {
        end += 1;
      }
      const word = source.slice(i, end);
      if (word === "null") tokens.push({ type: "value", value: null });
      else if (word === "true") tokens.push({ type: "value", value: true });
      else if (word === "false") tokens.push({ type: "value", value: false });
      else tokens.push({ type: "path", path: word });
      i = end;
    } else {
      throw new Error(`unsupported character ${JSON.stringify(ch)} in: ${source}`);
    }
  }
  return tokens;
}

function resolvePath(path, contexts) {
  let current = contexts;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return null;
    current = current[segment];
  }
  return current === undefined ? null : current;
}

/** GitHub's truthiness: null, false, '' and 0 are falsy; anything else is not. */
function truthy(value) {
  return !(
    value === null ||
    value === undefined ||
    value === false ||
    value === "" ||
    value === 0
  );
}

function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (type) => {
    if (!peek() || peek().type !== type) {
      throw new Error(`expected ${type}, got ${JSON.stringify(peek())}`);
    }
    return tokens[pos++];
  };

  function primary() {
    const token = peek();
    if (!token) throw new Error("unexpected end of expression");
    if (token.type === "(") {
      eat("(");
      const inner = or();
      eat(")");
      return inner;
    }
    pos += 1;
    if (token.type === "value") return { kind: "value", value: token.value };
    if (token.type === "path") return { kind: "path", path: token.path };
    throw new Error(`unexpected token ${JSON.stringify(token)}`);
  }

  function comparison() {
    const left = primary();
    const token = peek();
    if (token && (token.type === "==" || token.type === "!=")) {
      pos += 1;
      return { kind: token.type, left, right: primary() };
    }
    return left;
  }

  function and() {
    let node = comparison();
    while (peek() && peek().type === "&&") {
      pos += 1;
      node = { kind: "&&", left: node, right: comparison() };
    }
    return node;
  }

  function or() {
    let node = and();
    while (peek() && peek().type === "||") {
      pos += 1;
      node = { kind: "||", left: node, right: and() };
    }
    return node;
  }

  const tree = or();
  if (pos !== tokens.length) {
    throw new Error(`trailing tokens at ${pos}: ${JSON.stringify(tokens.slice(pos))}`);
  }
  return tree;
}

function evaluateNode(node, contexts) {
  switch (node.kind) {
    case "value":
      return node.value;
    case "path":
      return resolvePath(node.path, contexts);
    case "==":
      return evaluateNode(node.left, contexts) === evaluateNode(node.right, contexts);
    case "!=":
      return evaluateNode(node.left, contexts) !== evaluateNode(node.right, contexts);
    case "&&": {
      const left = evaluateNode(node.left, contexts);
      return truthy(left) ? evaluateNode(node.right, contexts) : left;
    }
    case "||": {
      const left = evaluateNode(node.left, contexts);
      return truthy(left) ? left : evaluateNode(node.right, contexts);
    }
    default:
      throw new Error(`unsupported node ${node.kind}`);
  }
}

export function evaluate(expression, contexts) {
  return evaluateNode(parse(tokenize(expression)), contexts);
}

/** Renders a string containing zero or more `${{ ... }}` substitutions. */
export function renderTemplate(template, contexts) {
  return template.replace(/\$\{\{(.+?)\}\}/g, (_match, expression) => {
    const value = evaluate(expression.trim(), contexts);
    return value === null || value === false ? "" : String(value);
  });
}

// --------------------------------------------------------------------------
// Pull the two live expressions straight out of ci.yml. Each extraction
// asserts it matched exactly once, so renaming the job or moving the key
// fails this file loudly instead of quietly testing nothing.
// --------------------------------------------------------------------------

function extractOnce(pattern, label, source = workflow) {
  const matches = [...source.matchAll(pattern)];
  expect(matches, `expected exactly one ${label} in ci.yml`).toHaveLength(1);
  return matches[0][1].trim();
}

const concurrencyGroup = extractOnce(/^ {2}group: (.+)$/gm, "concurrency group");

const qualityJob = (() => {
  const start = workflow.indexOf("\n  quality:\n");
  expect(start, "ci.yml should declare a job named `quality`").toBeGreaterThan(-1);
  return workflow.slice(start);
})();
const qualityIf = extractOnce(/^ {4}if: (.+)$/gm, "quality job `if:`", qualityJob);

const pullRequestTrigger = (() => {
  const match = workflow.match(/^ {2}pull_request:\n((?: {4}.*\n|\n)*)/m);
  expect(match, "ci.yml should declare an `on.pull_request` trigger").not.toBeNull();
  return match[1];
})();

// --------------------------------------------------------------------------
// Payloads. Both expressions read the `github` context and nothing else --
// asserted below rather than assumed, because a context this file does not
// model would resolve to null here and could pass a test it should fail.
// --------------------------------------------------------------------------

const pullRequestEvent = (action, extra = {}) => ({
  github: {
    event_name: "pull_request",
    ref: "refs/pull/224/merge",
    event: {
      action,
      pull_request: { number: 224 },
      ...extra,
    },
  },
});

const PAYLOADS = {
  "push to main": {
    contexts: {
      github: {
        event_name: "push",
        ref: "refs/heads/main",
        event: { before: "abc123" },
      },
    },
    runsQuality: true,
    group: "ci-refs/heads/main-code",
  },
  "PR opened": {
    contexts: pullRequestEvent("opened"),
    runsQuality: true,
    group: "ci-224-code",
  },
  "PR synchronize (a push to the head branch)": {
    contexts: pullRequestEvent("synchronize"),
    runsQuality: true,
    group: "ci-224-code",
  },
  "PR reopened": {
    contexts: pullRequestEvent("reopened"),
    runsQuality: true,
    group: "ci-224-code",
  },
  "PR edited: title only": {
    contexts: pullRequestEvent("edited", {
      changes: { title: { from: "old title" } },
    }),
    runsQuality: false,
    group: "ci-224-edited",
  },
  "PR edited: body only": {
    contexts: pullRequestEvent("edited", {
      changes: { body: { from: "old body" } },
    }),
    runsQuality: false,
    group: "ci-224-edited",
  },
  "PR edited: base ref changed (the auto-retarget)": {
    contexts: pullRequestEvent("edited", {
      changes: {
        base: {
          ref: { from: "build/ugcportal-fb32-qa-image" },
          sha: { from: "0a9e051" },
        },
      },
    }),
    runsQuality: true,
    group: "ci-224-code",
  },
  "PR edited: title and base changed together": {
    contexts: pullRequestEvent("edited", {
      changes: {
        title: { from: "old title" },
        base: { ref: { from: "build/ugcportal-fb32-qa-image" } },
      },
    }),
    runsQuality: true,
    group: "ci-224-code",
  },
};

describe("ci.yml triggers", () => {
  it("has no base-branch filter, so a stacked PR still gets a run (K1)", () => {
    expect(pullRequestTrigger).not.toMatch(/^ {4}branches(-ignore)?:/m);
  });

  it("still only runs the push build for main", () => {
    expect(workflow).toMatch(/^ {2}push:\n {4}branches: \[main\]$/m);
  });

  it("still subscribes to the edited event, which carries the retarget", () => {
    expect(pullRequestTrigger).toMatch(
      /^ {4}types: \[opened, synchronize, reopened, edited\]$/m,
    );
  });
});

describe("the quality job's gate", () => {
  for (const [name, { contexts, runsQuality }] of Object.entries(PAYLOADS)) {
    it(`${runsQuality ? "runs" : "skips"} the suite on: ${name}`, () => {
      expect(truthy(evaluate(qualityIf, contexts))).toBe(runsQuality);
    });
  }

  it("runs on a retarget, which is what gh-224 would have reached main without (K2)", () => {
    const retarget = PAYLOADS["PR edited: base ref changed (the auto-retarget)"];
    expect(truthy(evaluate(qualityIf, retarget.contexts))).toBe(true);
  });

  it("still skips a title-only and a body-only edit (K3, ugcportal-0an4)", () => {
    expect(truthy(evaluate(qualityIf, PAYLOADS["PR edited: title only"].contexts))).toBe(
      false,
    );
    expect(truthy(evaluate(qualityIf, PAYLOADS["PR edited: body only"].contexts))).toBe(
      false,
    );
  });
});

describe("the concurrency group", () => {
  for (const [name, { contexts, group }] of Object.entries(PAYLOADS)) {
    it(`is ${group} for: ${name}`, () => {
      expect(renderTemplate(concurrencyGroup, contexts)).toBe(group);
    });
  }

  it("keeps edit runs and code runs in separate groups (K3, ugcportal-sxwb)", () => {
    const edited = renderTemplate(
      concurrencyGroup,
      PAYLOADS["PR edited: body only"].contexts,
    );
    const code = renderTemplate(
      concurrencyGroup,
      PAYLOADS["PR synchronize (a push to the head branch)"].contexts,
    );
    expect(edited).not.toBe(code);
  });

  it("never lets a pull_request run share a group with a push to main", () => {
    const push = renderTemplate(concurrencyGroup, PAYLOADS["push to main"].contexts);
    for (const [name, { contexts }] of Object.entries(PAYLOADS)) {
      if (name === "push to main") continue;
      expect(renderTemplate(concurrencyGroup, contexts)).not.toBe(push);
    }
  });

  it("cancels in-progress runs for pull_request events only", () => {
    const cancel = extractOnce(
      /^ {2}cancel-in-progress: (.+)$/gm,
      "cancel-in-progress",
    );
    expect(
      truthy(evaluate(cancel.replace(/^\$\{\{|\}\}$/g, "").trim(), PAYLOADS["push to main"].contexts)),
    ).toBe(false);
    expect(
      truthy(
        evaluate(
          cancel.replace(/^\$\{\{|\}\}$/g, "").trim(),
          PAYLOADS["PR opened"].contexts,
        ),
      ),
    ).toBe(true);
  });

  it("stays the inverse of the quality job's gate", () => {
    // The drift guard. Every run in the `-code` group must carry a quality
    // result, because a newer one in that group cancels an older one; and no
    // run in the `-edited` group may, because those cancel each other freely.
    for (const [name, { contexts }] of Object.entries(PAYLOADS)) {
      const group = renderTemplate(concurrencyGroup, contexts);
      const runsQuality = truthy(evaluate(qualityIf, contexts));
      expect(group.endsWith("-code"), `${name} -> ${group}`).toBe(runsQuality);
    }
  });
});

describe("the contexts these expressions read", () => {
  it("are only `github`, which is the only one these payloads model", () => {
    const paths = [concurrencyGroup, qualityIf]
      .join(" ")
      .match(/\b[a-z_]+(?:\.[A-Za-z0-9_]+)+/g)
      .filter((path) => !path.startsWith("github."));
    expect(paths).toEqual([]);
  });
});

describe("the expression evaluator itself", () => {
  it("returns null for a path through a missing object, as GitHub does", () => {
    expect(evaluate("github.event.changes.base", { github: { event: {} } })).toBeNull();
  });

  it("gives && and || GitHub's value semantics, not booleans", () => {
    expect(evaluate("true && 'edited'", {})).toBe("edited");
    expect(evaluate("false && 'edited'", {})).toBe(false);
    expect(evaluate("'' || 'code'", {})).toBe("code");
    expect(evaluate("'a' || 'b'", {})).toBe("a");
  });

  it("rejects syntax it does not model rather than guessing", () => {
    expect(() => evaluate("!github.event.changes", {})).toThrow();
    expect(() => evaluate("github.event.action ==", {})).toThrow();
  });
});

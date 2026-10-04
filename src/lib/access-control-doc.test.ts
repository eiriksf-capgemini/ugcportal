import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * docs/access-control.md tells an operator what `DELETE FROM User` destroys,
 * so they can decide whether to remove an account that got in while the
 * sign-in gate was missing (ugcportal-egp).
 *
 * That list was wrong when first written — it named four of the seven
 * cascades and omitted `InstagramAccount` (taking `accessTokenEncrypted`
 * with it) and `ResaleRightsReview` (taking a standing rights clearance and
 * its `rights-evidence/` pointers). An incomplete list of what not to delete
 * is worse than no list, because the reader treats it as the complete
 * answer.
 *
 * So the doc is checked against the schema rather than against the memory of
 * whoever last edited it. Add a cascade to prisma/schema.prisma and this
 * fails until the runbook says so.
 */

const REPO_ROOT = path.resolve(__dirname, "../..");

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

type CascadeEdge = { child: string; parent: string };

/**
 * Every `onDelete: Cascade` relation in the schema, as child -> parent.
 *
 * Deliberately a parse of the schema and not of the migrations: the schema is
 * what the next migration will be generated from, and the migration history
 * contains tables that later migrations dropped (`CuratedPost` and
 * `PostRightsClearance` went in ugcportal-vsm), which would put models in
 * this list that no longer exist.
 */
function cascadeEdges(schema: string): CascadeEdge[] {
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
  const edges: CascadeEdge[] = [];
  for (const [, child, body] of models) {
    for (const line of body.split("\n")) {
      const relation = line.match(/^\s*\w+\s+(\w+)\??\s+@relation\((.*)\)/);
      if (relation && /onDelete:\s*Cascade/.test(relation[2])) {
        edges.push({ child, parent: relation[1] });
      }
    }
  }
  return edges;
}

/** Everything a `DELETE FROM User` takes with it, transitively. */
function cascadeClosureFromUser(schema: string): string[] {
  const edges = cascadeEdges(schema);
  const reached = new Set<string>();
  const frontier = ["User"];
  while (frontier.length > 0) {
    const parent = frontier.shift() as string;
    for (const edge of edges) {
      if (edge.parent === parent && !reached.has(edge.child)) {
        reached.add(edge.child);
        frontier.push(edge.child);
      }
    }
  }
  return [...reached].sort();
}

/**
 * The `Destroyed` column of the runbook table, which uses `code` cells.
 *
 * `^\s*\|` rather than `^\|`: the table is nested inside a numbered list
 * item, so every row is indented. Anchoring at the line start alone matched
 * nothing and the first version of this test reported an empty list — which
 * the "finds cascades at all" guard above is there to make loud instead of
 * letting the comparison pass on two empty arrays.
 */
function documentedCascades(doc: string): string[] {
  const rows = [...doc.matchAll(/^\s*\|\s*`(\w+)`\s*\|\s*`[\w.]+`\s*\|/gm)];
  return [...new Set(rows.map(([, model]) => model))].sort();
}

const schema = read("prisma/schema.prisma");
const doc = read("docs/access-control.md");

describe("the delete-cascade runbook matches the schema", () => {
  it("finds cascades in the schema at all", () => {
    // Guards the two checks below against passing because the parser broke
    // and both sides came back empty.
    expect(cascadeEdges(schema).length).toBeGreaterThan(0);
    expect(cascadeClosureFromUser(schema).length).toBeGreaterThan(0);
    expect(documentedCascades(doc).length).toBeGreaterThan(0);
  });

  it("documents exactly what a user delete destroys — no more, no fewer", () => {
    expect(documentedCascades(doc)).toEqual(cascadeClosureFromUser(schema));
  });

  it("still names the two that were missing the first time", () => {
    // Belt and braces on the equality above: these two are the expensive
    // ones, and the ones a reader is least likely to expect.
    const documented = documentedCascades(doc);
    expect(documented).toContain("InstagramAccount");
    expect(documented).toContain("ResaleRightsReview");
  });

  it("names the schema commit the list was derived from", () => {
    // So the next reader can tell whether it has aged, and re-derive it.
    expect(doc).toMatch(/Enumerated from `prisma\/schema\.prisma` as of \w{7}/);
  });
});

describe("the runbook does not recommend a command that prints nothing", () => {
  it("keeps prisma db execute away from the audit step", () => {
    /*
      `prisma db execute` is documented as "not meant for returning data";
      a SELECT through it prints "Script executed successfully." and no
      rows. An operator auditing who signed in while the gate was missing
      would read that as "nobody" (PR #45 review, round 3).

      Checked as a property of the text because the failure is silent: the
      command succeeds, so nothing else would ever catch it.
    */
    const auditStep = doc.slice(
      doc.indexOf("Audit who got in while the door was open"),
      doc.indexOf("Revoke every session"),
    );
    expect(auditStep).not.toBe("");

    // The COMMANDS, not the prose. The first version of this test searched
    // the whole section, so it passed when the command was swapped back to
    // `prisma db execute` — the surrounding paragraph still said "sqlite3"
    // and still explained why. An assertion that reads the explanation
    // instead of the thing explained cannot fail for the reason it exists.
    const commands = [...auditStep.matchAll(/```bash\n([\s\S]*?)```/g)].map(
      ([, body]) => body,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).not.toMatch(/prisma\s+db\s+execute/);
    expect(commands[0]).toMatch(/^\s*sqlite3\b/m);
  });
});

/**
 * ugcportal-mzr K3: the doc says which of the three mechanisms was chosen,
 * what the revocation bound is, and what the operator must still do by hand.
 *
 * The list of refusals that destroy session rows is checked against the
 * CODE rather than against the memory of whoever last edited the doc, in the
 * same spirit as the cascade check above: the dangerous drift is not a
 * missing section, it is a section that still describes the previous rule.
 * Add a refusal to `REVOKING_REFUSALS` and this fails until the runbook says
 * so — and the operator's mental model of "what does removing an entry
 * actually destroy" is the thing that would otherwise go quietly stale.
 */

const liveSession = read("src/lib/live-session.ts");

const REVOCATION_HEADING = "### Revoking access takes effect on the next request";
const DEPLOY_HEADING = "### Deploy order: migrate first, then deploy";

/** The refusals src/lib/live-session.ts deletes session rows for. */
function revokingRefusals(source: string): string[] {
  const block = source.match(
    /REVOKING_REFUSALS[^=]*=\s*\[([\s\S]*?)\];/,
  );
  if (!block) {
    return [];
  }
  return [...block[1].matchAll(/"([a-z-]+)"/g)].map(([, name]) => name).sort();
}

/** The ones the doc tells the operator are destructive. */
function documentedRevokingRefusals(section: string): string[] {
  const sentence = section.match(
    /decision about the list\*\s*\(([^)]*)\)\s*also\s*\*\*deletes that/,
  );
  if (!sentence) {
    return [];
  }
  return [...sentence[1].matchAll(/`([a-z-]+)`/g)]
    .map(([, name]) => name)
    .sort();
}

const revocationSection = doc.slice(
  doc.indexOf(REVOCATION_HEADING),
  doc.indexOf(DEPLOY_HEADING),
);

describe("the revocation runbook matches the code", () => {
  it("has a section at all", () => {
    // Guards the checks below against passing on two empty strings.
    expect(doc).toContain(REVOCATION_HEADING);
    expect(doc).toContain(DEPLOY_HEADING);
    expect(revocationSection.length).toBeGreaterThan(0);
    expect(revokingRefusals(liveSession).length).toBeGreaterThan(0);
  });

  it("names exactly the refusals that destroy session rows", () => {
    expect(documentedRevokingRefusals(revocationSection)).toEqual(
      revokingRefusals(liveSession),
    );
  });

  it("states the bound, rather than only that there is one", () => {
    // "within a bound that is written down" — the thing an operator needs is
    // the number or the event, not the adjective.
    expect(revocationSection).toMatch(
      /\*\*The bound is the next request that resolves their session\*\*/,
    );
  });

  it("says which of the three mechanisms was chosen and what the others were", () => {
    expect(revocationSection).toContain("session.maxAge");
    expect(revocationSection).toContain("revoke all sessions");
  });

  it("tells the operator what is still theirs to do", () => {
    expect(revocationSection).toContain(
      "What an operator still has to do by hand:",
    );
    // The one that is not optional: the policy is read from the process
    // environment, so an unrestarted server keeps the old list.
    expect(revocationSection).toMatch(/\*\*Restart or redeploy\*\*/);
  });
});

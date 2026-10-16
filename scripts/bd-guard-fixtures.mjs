/**
 * Fixture loader for scripts/bd-guard.test.mjs (ugcportal-ucnf). Finds the
 * blessed-form examples in the skill files by content anchor, never by line
 * number, so an edit above them cannot move a pin. Every failure to find
 * exactly one block throws, naming the file and the anchor (review-standards
 * section 6): a loader that returned the first of several matches, or an empty
 * slice, would let the guard tests pass on text that is not a blessed form.
 */
import fs from "node:fs";

// `$(cat <<'EOF'`, `$(cat <<"EOF"`, and the `<<-` variants.
export const OPENER = /\$\(cat\s+<<-?\s*(["'])([A-Za-z_][A-Za-z0-9_]*)\1/;

function describeAnchor(anchor) {
  return anchor instanceof RegExp ? String(anchor) : JSON.stringify(anchor);
}

function matches(line, anchor) {
  if (anchor instanceof RegExp) return anchor.test(line);
  return line.includes(anchor);
}

function uniqueAnchorIndex(file, all, anchor) {
  const hits = [];
  all.forEach((line, i) => {
    if (matches(line, anchor)) hits.push(i);
  });
  if (hits.length !== 1) {
    throw new Error(
      `fixture anchor ${describeAnchor(anchor)} matched ${hits.length} line(s) in ${file}; expected exactly 1`,
    );
  }
  return hits[0];
}

/**
 * The block from the first blessed opener at or after the (unique) anchor line,
 * through the terminator line and the line that follows it, which must begin
 * with `)`.
 */
export function loadBlessedBlock(file, anchor) {
  const all = fs.readFileSync(file, "utf8").split("\n");
  const at = uniqueAnchorIndex(file, all, anchor);
  let open = -1;
  let m = null;
  for (let i = at; i < all.length; i++) {
    m = OPENER.exec(all[i]);
    if (m) {
      open = i;
      break;
    }
  }
  if (open < 0) {
    throw new Error(`no blessed opener after fixture anchor ${describeAnchor(anchor)} in ${file}`);
  }
  const delim = m[2];
  const dashed = /<<-/.test(m[0]);
  for (let i = open + 1; i < all.length; i++) {
    const isTerm = dashed ? all[i].replace(/^\t+/, "") === delim : all[i] === delim;
    if (!isTerm) continue;
    if (!(all[i + 1] ?? "").startsWith(")")) {
      throw new Error(
        `terminator ${delim} after fixture anchor ${describeAnchor(anchor)} in ${file} is not followed by a ) line`,
      );
    }
    return all.slice(open, i + 2).join("\n");
  }
  throw new Error(`no ${delim} terminator after fixture anchor ${describeAnchor(anchor)} in ${file}`);
}

/** The single line matching the (unique) anchor, for the `$(cat "<path>")` forms. */
export function loadBlessedLine(file, anchor) {
  const all = fs.readFileSync(file, "utf8").split("\n");
  return all[uniqueAnchorIndex(file, all, anchor)];
}

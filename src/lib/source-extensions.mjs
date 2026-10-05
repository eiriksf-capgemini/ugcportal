/**
 * The one list of "file extensions this repo treats as executable
 * JavaScript-family source" (ugcportal-ysub review round 3, finding 4).
 *
 * Four places had their own copy, and each one was widened in a different
 * review round: `scriptKindFor` in src/lib/design/scan-source.ts picks a
 * parse dialect per extension, eslint.config.mjs's two `no-restricted-*`
 * blocks say which files the gated-script rules apply to, and
 * analytics-host.grep.test.ts's `K6_SCANNED_EXTENSIONS` says which files
 * the vendor-host grep reads. A gate that scans `.cjs` while the lint rule
 * does not - which is exactly what this bead found and fixed - is a bypass
 * surface nobody wrote down, so the list lives here and they all read it.
 *
 * A plain `.mjs` module deliberately: eslint.config.mjs is loaded by Node
 * as ESM and cannot import TypeScript, while the TypeScript side imports
 * `.mjs` happily (eslint-gated-script.test.ts already imports
 * eslint.config.mjs itself). This is the only shape both sides can share.
 *
 * `source-extensions.test.ts` is what keeps them honest: it asserts every
 * consumer derives from this list rather than restating it.
 */

/**
 * Extensions whose files can execute a tracking snippet. `.ts`/`.tsx` need
 * a compiler, the rest do not - which is the point: "it needs TypeScript"
 * was never a reason a file could not be a bypass.
 *
 * `.mts`/`.cts` are here even though this repo has no such file today
 * (review round 3, second pass): scan-source.ts's own prose already
 * reasoned about `.cts` as a CommonJS source kind while no list actually
 * contained it, which is the "a comment claims what the code does not do"
 * shape, and the extension pair is exactly the sort of thing that arrives
 * with a toolchain change rather than a deliberate decision. Listing them
 * now costs nothing and means the first one to appear is covered by the
 * lint rules, the grep and the parser's dialect map at once, instead of
 * by whichever of the three someone remembers.
 */
export const JS_FAMILY_EXTENSIONS = [
  "ts",
  "tsx",
  "mts",
  "cts",
  "js",
  "jsx",
  "mjs",
  "cjs",
];

/**
 * The subset eslint.config.mjs gives the JSX-shaped selectors to (a raw
 * `<script>` element) plus the hex-colour guardrail. Split out because
 * flat config REPLACES an earlier object's selectors for a rule key rather
 * than merging them, so two `no-restricted-syntax` objects matching the
 * same file would silently drop one's selectors; the two file sets must
 * therefore never overlap. The partition is derived here, from one list,
 * rather than from two hand-written arrays that can drift apart.
 *
 * `.js`/`.mjs`/`.cjs` sit in the OTHER half even though Next would compile
 * JSX in a `.js` file: this repo authors JSX only in `.tsx`/`.jsx`, and
 * that is the partition that shipped. Authoring a JSX component in a `.js`
 * file would mean moving it here - which is a one-line change in one
 * place now, instead of four.
 */
export const JSX_LINTED_EXTENSIONS = ["tsx", "jsx"];

/** Everything else: no authored JSX, so no JSX selectors needed. */
export const NON_JSX_LINTED_EXTENSIONS = JS_FAMILY_EXTENSIONS.filter(
  (extension) => !JSX_LINTED_EXTENSIONS.includes(extension),
);

/** `["**\/*.ts", ...]` — ESLint `files`/`ignores` glob form. */
export function globsFor(extensions) {
  return extensions.map((extension) => `**/*.${extension}`);
}

/** `/\.(ts|tsx|js|jsx|mjs|cjs)$/` — the file-walker form. */
export function filenamePatternFor(extensions) {
  return new RegExp(`\\.(${extensions.join("|")})$`);
}

/** Every JS-family file, as a walker pattern. */
export const JS_FAMILY_FILENAME_PATTERN = filenamePatternFor(JS_FAMILY_EXTENSIONS);

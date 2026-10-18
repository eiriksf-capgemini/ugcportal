// Worker cap (ugcportal-gdi0). vitest 3 read VITEST_MAX_FORKS and
// VITEST_MAX_THREADS itself; vitest 4 reads only VITEST_MAX_WORKERS and
// silently ignores them. vitest.config.ts maps the two old names onto
// maxWorkers through this function so the cap keeps applying.
//
// Rule: an empty (or whitespace-only) value counts as unset, for both
// variables. A value that is set but is not a positive integer throws. This
// mapping is stricter than vitest 3 for 1.5 and 2abc, but more lenient for a
// whitespace-only value. vitest 3 used Number.parseInt (measured on vitest
// 3.2.7 with four 1.5 s files): 1.5 ran capped at 1 and 2abc ran capped at 2
// (both throw here); 0 ran no tests; abc and -1 were refused; a lone space
// was refused by vitest 3.2.7 but is accepted as unset here (trim() then the
// empty-string continue below).
// Precedence: VITEST_MAX_FORKS, then VITEST_MAX_THREADS; the first one that is
// set wins (both are validated), and neither set means no cap (vitest's own default).
export function resolveWorkerCap(env: NodeJS.ProcessEnv): number | undefined {
  let cap: number | undefined;
  for (const name of ["VITEST_MAX_FORKS", "VITEST_MAX_THREADS"]) {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === "") continue;
    if (!/^[1-9]\d*$/.test(raw)) {
      throw new Error(`${name}=${JSON.stringify(raw)} is not a positive integer (vitest worker cap)`);
    }
    cap ??= Number.parseInt(raw, 10);
  }
  return cap;
}

// Kept here, not in vitest.config.ts: a config module with a named export
// beside its default export makes rolldown print MIXED_EXPORTS on every run
// (ugcportal-wcga).
// Entries vitest 3.2.7's defaultExclude had and vitest 4.1.12's dropped; copied
// verbatim from vitest 3.2.7 dist/chunks/defaults.B7q_naMc.js:6-12.
export const vitest3DroppedExcludes = [
  "**/dist/**",
  "**/cypress/**",
  "**/.{idea,git,cache,output,temp}/**",
  "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
];

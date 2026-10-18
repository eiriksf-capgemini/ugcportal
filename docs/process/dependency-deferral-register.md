# Dependency deferral register

Written 2026-10-17 for ugcportal-pc7s. One row per major-version move that was
looked at and deliberately NOT taken. Every reason below is something that was
checked; the command is in the Evidence column. Re-check a row before acting
on it: versions drift, and a row whose reason no longer holds should be taken
or rewritten, not left standing.

Measured at origin/main 3aa6508 from a clean `npm ci`, with npm 11 on Node 24.20.

| Package | Installed | Candidate | Direction | Reason not taken | Date | Owner bead |
|---|---|---|---|---|---|---|
| prisma (and @prisma/client) | 7.10.0 | 6.19.3 | **downgrade** | `npm audit` once proposed it as a fix for the `prisma` / `@prisma/config` / `mysql2` / `deepmerge-ts` chain. It is a major downgrade of the ORM and its libsql adapter for an advisory chain that, as of this date, reports `fixAvailable: true` (a non-breaking fix), so the downgrade is not needed. The newest major, 8.0.0-rc.23, is a release candidate and is not taken either. | 2026-10-17 | ugcportal-fuv2 (non-breaking bump) |
| shadcn | 4.21.0 (now removed) | 1.0.0 | **downgrade** | `npm audit` proposed shadcn@1.0.0 for the ts-morph / fast-glob / micromatch / braces chain. Three majors back, for a package whose only runtime use here was one stylesheet. Handled a different way: the stylesheet is vendored and the package dropped (ugcportal-pc7s). The CLI is still run on demand with `npx shadcn@latest add ...` (components.json). | 2026-10-17 | ugcportal-pc7s |
| eslint-config-next | 16.4.0 | 14.2.35 | **downgrade** | `npm audit` proposes it for fast-glob / micromatch / braces via @next/eslint-plugin-next. 14.2.35 peers on `eslint ^7 \|\| ^8`; this repo is on eslint 9, and next is 16.4.0 with the config pinned to match. Those advisories stay open until a non-downgrade fix exists. | 2026-10-17 | ugcportal-pg85 (standing rule for accepting such an advisory) |
| jsdom | 26.1.0 | 30.1.3 | upgrade | jsdom 30 needs Node `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`; CI runs Node 20. Taking it means a CI Node bump first, and `.github/workflows/` is a sensitive path. | 2026-10-17 | none yet |
| vitest | 3.2.7 | 5.0.5 | upgrade, two majors | Carries the 2 critical advisories (tinypool, vitest) and the @vitest/mocker one. Two majors across the whole test suite; handled as its own bead, not folded into a dependency sweep. | 2026-10-17 | ugcportal-gdi0 |
| eslint | 9.39.5 | 10.13.0 | upgrade | `eslint-config-next@16.4.0` is the installed config; its peer range for 16.4.2 is `eslint >=9.0.0`, so 10 is permitted but is not required by any advisory, and was not trialled. Not taken for lack of a reason to; not evidence that it breaks. | 2026-10-17 | none |
| @types/node | 20.19.43 | 26.6.5 | upgrade | Typings should track the Node runtime CI and the image use (Node 20, see the jsdom row); types for a newer Node than the runtime would describe APIs that are absent. | 2026-10-17 | none |
| prisma family (prisma, @prisma/*) | 7.10.0 | 7.10.1 | patch, in range | NOT deferred: taken. The advisories deepmerge-ts GHSA-ggr8-5vv4-36mx (7.1.5 pinned in `@prisma/config`) and mysql2 GHSA-3f6p-5ww8-9rcr and GHSA-rgwj-5xj2-c3m3 (3.15.3 pinned in `prisma`) are fixed by `npm audit fix` (no `--force`), which moves the prisma family to 7.10.1 inside the existing `^7.10.0` ranges, deepmerge-ts to 8.0.2 and mysql2 to 3.24.4. `npm audit` after: high 5, the braces chain only. | 2026-10-18 | ugcportal-90i5 |

## Evidence

- Installed and latest: `npm outdated` and `npm ls --depth=0` in a clean worktree, and
  `npm view <pkg> dist-tags.latest`.
- jsdom engines: `npm view jsdom@30.1.3 engines.node` -> `^22.22.2 || ^24.15.0 || >=26.0.0`.
  CI Node: `grep -n node-version .github/workflows/ci.yml` -> `143:          node-version: 20`.
- Audit-proposed downgrades: `npm audit --json`, the `fixAvailable` field of
  `shadcn`, `eslint-config-next`, `vitest` (all `isSemVerMajor: true`) and of `prisma` /
  `@prisma/config` / `mysql2` / `deepmerge-ts` (`true`). Never run `npm audit fix --force`:
  it applies the downgrades above.
- eslint peers: `npm view eslint-config-next@14.2.35 peerDependencies` ->
  `eslint: '^7.23.0 || ^8.0.0'`.
- Prisma 6 exists: `npm view prisma@6 version` -> 6.19.3. Whether prisma 7.10.1 clears the
  `mysql2` / `deepmerge-ts` advisories was not checked here and fuv2 closed without checking;
  ugcportal-90i5 checked it on 2026-10-18: it does (see the prisma 7.10.1 row above).

## shadcn after ugcportal-pc7s

shadcn is **not** a dependency any more, and it was never unused: `src/app/globals.css`
imported `shadcn/tailwind.css`. That stylesheet is vendored at
`src/app/vendor/shadcn-tailwind.css` (header records version and sha256), and
`src/app/vendor/shadcn-tailwind.test.ts` fails if the import is deleted or
commented out, if the compiled globals.css loses the vendored `no-scrollbar` utility,
or if the vendored bytes change. Do not remove the import on the belief it is unused.
Dropping the package took four advisories out of the tree (shadcn, ts-morph,
@ts-morph/common, @modelcontextprotocol/sdk). fast-glob, micromatch and braces
stay, because `eslint-config-next` reaches them too.

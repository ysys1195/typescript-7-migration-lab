# Ecosystem compatibility

## Recorded scope

The initial ecosystem pass covers typescript-eslint, Vite, and Vitest. The checked-in
observation was recorded on 2026-08-13 JST with Node 24.14.0 and npm 11.9.0. It is a result
for the exact versions below, not a permanent statement about future releases.

| Tool | Pinned version | Classification | Blocker | Executed evidence |
|---|---:|---|---|---|
| typescript-eslint | 8.67.0 | `TS6_COEXISTENCE_REQUIRED` | `PROGRAMMATIC_API_WAITING` | normal TS7-only install failed; forced API probe failed; coexistence lint and both compiler CLIs passed |
| ESLint | 9.39.5 | supporting version | — | loaded the typed rule in both typescript-eslint probes |
| Vite | 6.4.3 | `TS7_STANDALONE` | — | TS7 typecheck and production build passed |
| Vitest | 4.1.10 | `TS7_STANDALONE` | — | TS7 typecheck and one TypeScript runtime test passed |

`compatibility/ecosystem-results.json` contains every command, exit code, stdout, and
stderr. Repository and home paths plus separators and line endings are normalized; tool
diagnostics are otherwise retained. Each fixture has an exact `package.json` and lockfile
under `fixtures/ecosystem/`.

`TS7_STANDALONE` means the tested minimum path needs no TS6 package.
`TS6_COEXISTENCE_REQUIRED` means the tool works with the documented side-by-side setup.
`PROGRAMMATIC_API_WAITING` records that a stable TS7 compiler API is the blocker behind
that coexistence requirement. `UNAVAILABLE` is reserved for a failed tool with no working
documented path; none of these three tools has that classification in this run.

## typescript-eslint

The TS7-only fixture proves two separate points. First, `npm ci` rejects
typescript-eslint 8.67.0 because its TypeScript peer range is `>=4.8.4 <6.1.0`. Second,
forcing that unsupported install does not make it usable: the TS7 CLI typecheck passes,
but ESLint exits with the tool's explicit `typescript-eslint does not support TS 7.0`
message.

The reason is the API boundary, not TypeScript syntax. TypeScript 7.0 does not ship a
stable compiler API, and the TypeScript team specifically recommends side-by-side TS6 for
programmatic consumers such as typescript-eslint. The supported versions page also keeps
typescript-eslint 8.67.0 below TypeScript 6.1.

The working fixture applies that workaround with exact aliases:

```json
{
  "devDependencies": {
    "@typescript/native": "npm:typescript@7.0.2",
    "typescript": "npm:@typescript/typescript6@6.0.2"
  }
}
```

`typescript` therefore resolves to the stable TS6 API used by ESLint, `tsc6` remains
available for a TS6 comparison, and the alias contributes the TS7 `tsc` binary. In the
recorded run, lint, `tsc6 --project tsconfig.json`, and TS7
`tsc --project tsconfig.json` all passed. Do not use `--force` as the migration strategy;
it exists only in the negative fixture to expose the runtime guard.

Sources: [TypeScript 7.0 side-by-side guidance](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-60),
[typescript-eslint supported dependency versions](https://typescript-eslint.io/users/dependency-versions/).

## Vite

Vite 6.4.3 built the fixture with `typescript@7.0.2` as its only TypeScript package, so it
is classified as `TS7_STANDALONE`. This does not mean Vite performed a TypeScript type
check. Vite documents its TypeScript path as transpile-only and recommends a separate
`tsc --noEmit` step. The fixture runs that TS7 check before `vite build` so both claims are
observed independently.

Source: [Vite TypeScript features](https://vite.dev/guide/features.html#typescript).

## Vitest

Vitest 4.1.10 ran the TypeScript test through Vite 6.4.3 with
`typescript@7.0.2` as the only TypeScript package, so this minimum runtime-test path is
classified as `TS7_STANDALONE`. Vitest also documents that ordinary runtime tests are
transformed but not type-checked. The fixture therefore keeps a separate TS7
`tsc --project tsconfig.json` command and requires both commands to pass.

This result does not cover `vitest --typecheck`, custom Vite plugins, or tools that embed
the compiler API; those need their own fixtures before inheriting this classification.

Source: [Vitest: testing TypeScript](https://vitest.dev/guide/learn/writing-tests.html#testing-typescript).

## Reproduction

```bash
npm run ecosystem:verify
npm run test:ecosystem
```

`ecosystem:verify` reruns all installs and probes without changing the checked-in record.
After intentionally changing a package version or fixture, use
`npm run ecosystem:record`, inspect the complete JSON diff, and update this migration note
only when the new execution evidence supports a different classification.

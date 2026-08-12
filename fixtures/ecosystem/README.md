# Ecosystem compatibility fixtures

These fixtures test the first TypeScript 7 ecosystem migration paths from Issue #11.
Every package uses exact direct dependency versions and has its own lockfile so that an
observation cannot silently move to a newer tool release.

| Fixture | Question |
|---|---|
| `typescript-eslint-ts7-only` | Does the supported install and stable API path work with only TS7? |
| `typescript-eslint` | Can ESLint use the TS6 API while the same source is checked by TS7? |
| `vite` | Can Vite build TypeScript source with TS7 as the only compiler package? |
| `vitest` | Can Vitest execute a TypeScript test with TS7 as the only compiler package? |

Run all scenarios from the repository root:

```bash
npm run ecosystem:verify
```

The command performs `npm ci` inside each fixture, then runs the recorded checks. It needs
registry access on a clean checkout. Nested `node_modules` directories and Vite `dist`
output are ignored. To replace the checked-in execution record after intentionally
updating a pinned version, run:

```bash
npm run ecosystem:record
npm run test:ecosystem
```

The TS7-only typescript-eslint fixture deliberately performs one forced install after the
normal peer-dependency install fails. This is an evidence probe: its lint command must
also fail with the tool's TS7 API message. It is not the recommended workaround. The
working fixture uses the side-by-side aliases documented in
[`docs/ecosystem-compatibility.md`](../../docs/ecosystem-compatibility.md).

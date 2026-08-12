# Continuous integration

Pull requests and pushes to `main` run the compatibility workflow in
`.github/workflows/ci.yml`. The matrix intentionally separates platform coverage from
Node coverage without paying for every cross-product:

| Runner | Node versions |
|---|---|
| Ubuntu | 20, 22, 24 |
| macOS | 24 |
| Windows | 24 |

Every lane installs the root lockfile, generates the `small` fixture preset, runs the
unit/schema suite, and compares live compiler behavior with
`compatibility/ci-golden.json`.

## Compatibility gates

The golden records TS6 and TS7 independently so that a matching change in both compilers
does not silently pass.

- fixture smoke: expected exit codes for eight representative fixture projects,
  including the generated `many-files` input
- diagnostics: structured code, category, repository-relative path, location, message,
  and exit code for six fixtures
- emit: exact file list and contents for JavaScript and declaration output
- compiler versions: explicit TS6 and TS7 versions, making a lockfile compiler update an
  intentional golden change

Paths use `/`, diagnostics are repository-relative, and emit line endings use LF. These
are the only cross-platform normalizations. A platform-specific difference outside those
rules fails its lane and must be investigated before a platform-specific expectation is
added.

Run the same gate locally:

```bash
npm run fixtures:generate
npm test
npm run ci:compatibility
```

After an intentional compiler or compatibility change, regenerate rather than directly
editing the golden:

```bash
npm run ci:record
npm run test:ci
```

Inspect the complete golden diff and verify that a known TypeScript 7 change has not been
mistaken for a regression.

## Performance boundary

The workflow never runs `npm run benchmark`, `npm run lab`, `npm run lab:quick`, or a
historical threshold comparison. GitHub-hosted runner timing, CPU, and memory values are
therefore not pass/fail signals. Performance conclusions remain the responsibility of a
recorded lab run on a controlled machine; CI only checks compatibility and deterministic
artifacts.

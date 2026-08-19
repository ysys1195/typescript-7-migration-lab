# Local project benchmark adapter

The local project adapter checks whether the three compiler conditions observed with
synthetic fixtures show the same tendency in an existing Git checkout:

1. TypeScript 6
2. TypeScript 7 with `--singleThreaded`
3. TypeScript 7 with its default parallel configuration

It operates on the supplied checkout in place. It does not copy source files, run package
installation, accept manifest-defined environment values, or persist compiler output,
local paths, environment values, or project artifacts.

## Manifest

Each project uses a JSON manifest validated by
`schemas/local-project-manifest.schema.json`. The manifest records:

- an HTTPS source URL, SPDX-style license identifier, and exact 40-character commit
- a manual-only install command
- read-only compiler arguments for type checking and build planning
- the synthetic fixtures whose trends should be compared with each workload

`local-projects/vite-6.4.3.json` is a reproducible example. It pins Vite 6.4.3 to
commit `6c2c881f15495738ff03bc1d67cc052c07e0cac4` and records its MIT license.

The install command is documentation and a preparation contract. The adapter deliberately
never executes it. Run it yourself only after reviewing the target repository and command.
The manifest is copied into the result for reproducibility, so it must not contain secrets.

## Running the Vite example

Prepare a checkout outside this repository. The adapter requires the supplied path to be
the Git root, with the exact origin and commit in the manifest and no tracked or untracked
changes.

```bash
git clone https://github.com/vitejs/vite.git /path/to/vite
git -C /path/to/vite checkout 6c2c881f15495738ff03bc1d67cc052c07e0cac4
cd /path/to/vite
corepack pnpm install --frozen-lockfile --ignore-scripts
cd /path/to/typescript-7-migration-lab
npm run project:benchmark -- \
  --manifest local-projects/vite-6.4.3.json \
  --project /path/to/vite \
  --synthetic-run results/benchmark.json
```

Use `--runs`, `--warmups`, and `--timeout-ms` to override the defaults of 10 measured
runs, 2 warm-ups, and 120000 ms per compiler invocation.

The build workload uses TypeScript build mode with `--dry`. It measures compiler startup
and project-graph planning without performing the package's normal emitting build. It is
not equivalent to `pnpm build` and must not be described as end-to-end bundler performance.

## Read-only and privacy boundary

Before measuring, the adapter verifies all of the following:

- the path is the Git repository root
- `origin` matches the manifest source after normalizing HTTPS/SSH GitHub URLs
- `HEAD` exactly matches the pinned commit
- `git status --porcelain --untracked-files=all` is empty
- typecheck uses `--noEmit`; build mode uses `--dry`
- compiler arguments do not select output paths, watch mode, absolute paths, or `..`

Typecheck build-info is redirected to a temporary directory owned by the lab. After every
invocation, Git status is checked again. If a command changes the project, measurement
stops and the adapter does not delete, reset, or restore any user file.

Compiler stdout and stderr are used in memory to parse numeric extended diagnostics, but
their contents are never written to the result. Each stream is represented only by its
UTF-8 byte count and SHA-256 digest. The result also omits the supplied project path.
Environment variables cannot be declared in the manifest, and source files or generated
artifacts are never copied into the lab.

The controlled compiler commands make ignored-file writes unlikely, but Git cannot report
changes to ignored files. Review project configuration and the manual install command before
running an unfamiliar repository.

## Results and trend comparison

The versioned result is validated by `schemas/local-project-result.schema.json` and stored
at:

```text
results/runs/<run-id>/local-project.json
results/runs/<run-id>/manifest.json
```

These generated files remain ignored by Git. `npm run runs` lists both regular lab runs and
local project runs; `results/latest.json` continues to point only to a finalized regular lab
run. The result records the adapter repository commit and dirty state, plus the synthetic
baseline run ID when one is supplied, so the implementation and comparison source remain
auditable without recording either local filesystem path.

When `--synthetic-run` is supplied, the adapter calculates three ratios for the local
workload and the mapped fixture:

- native ratio: TS6 median / TS7 single-threaded median
- parallel ratio: TS7 single-threaded median / TS7 default median
- overall ratio: TS6 median / TS7 default median

`aligned` means all three ratios have the same direction (`faster`, `similar`, or `slower`)
with a +/-5% neutral band. `mixed` is evidence that the synthetic fixture and real project do
not show the same tendency. It is not automatically a regression. Missing or failed samples
produce `unavailable` instead of a fabricated ratio.

Results are specific to the pinned project, commit, installed dependencies, machine, and
compiler versions. One project must not be presented as representative of all TypeScript
codebases.

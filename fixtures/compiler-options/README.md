# Compiler option fixtures

Each subdirectory isolates one TS6-to-TS7 migration concern. Run the checked-in
catalog probes with:

```bash
npm run options
npm run options -- --id target-es5
```

Removed-option fixtures use `shared/index.ts`; default-behavior fixtures contain
only the source needed to make that default observable. Generated emit for the
`root-dir-default` probe is written to a temporary directory, never here.

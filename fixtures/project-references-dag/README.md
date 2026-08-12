# project-references-dag

The generator creates a layered project-reference graph. Every project in a
layer depends on every project in the preceding layer, exposing build scheduling
across a deeper graph than the small monorepo fixture. `--force` makes each timed
invocation rebuild the full graph; this does not measure incremental DAG builds.

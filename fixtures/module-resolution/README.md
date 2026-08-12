# module-resolution

One generated source file imports many generated packages with package exports
and declaration entrypoints. It emphasizes cold package resolution, but OS and
compiler filesystem caches can affect later attempts.

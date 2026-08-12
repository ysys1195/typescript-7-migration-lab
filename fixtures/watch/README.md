# watch

Each attempt starts a fresh watch process in a temporary fixture copy, waits for
the initial successful build, edits one source file, and records time until the
next successful watch cycle. Initial startup is excluded. CPU and peak RSS are
unavailable for this custom lifecycle because the watch process is terminated
after the observed update rather than exiting naturally.

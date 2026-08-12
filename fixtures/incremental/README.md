# incremental

The runner copies this generated import chain to a temporary directory for each
attempt and measures three states independently: initial build, no-change
rebuild, and rebuild after editing one source file. Cache preparation is excluded
from no-change and edit timings. Temporary copies prevent variants from sharing
`.tsbuildinfo` state.

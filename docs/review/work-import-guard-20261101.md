# Runtime import guard: equivalent AST traversal with less allocation

The full slice61 unit run had 14,782 passes and one 5-second timeout in the existing runtime import scan. An unchanged isolated run still took 5,117ms and failed. No forbidden import was reported; no timeout increase or exclusion was applied.

The visitor only follows AST children. It now asks TypeScript not to allocate unused parent pointers. All file enumeration, import/export/dynamic-import/require branches, path candidates, Next matcher and assertions are unchanged. An independent exhaustive comparison on the same source scanned **1,379 files and 6,879 imports**, returning exactly identical ordered file/module lists with and without parent links. The comparison measured 2,810ms versus 1,559ms; these are diagnostic local timings, not a promised universal speedup.

The unchanged five tests pass (3.75s test time), and the complete suite then passed **14,783 tests in 872 files** in 523.79s. Original failures, the comparison script/output and both passing runs are retained. Product source and the frozen slice61 build are unchanged. This optimization does not replace the runtime artifact verifiers or exact-head CI.

[Evidence](evidence/work-import-guard-20261101/manifest.json).

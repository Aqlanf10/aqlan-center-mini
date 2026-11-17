# Booking witnesses — WIP

This independent review branch restores two synthetic unit-test witnesses from source #541 (`4e88b6a791d859cc9a066888f54c0eddff91dde7`) onto prescription/booking WIP `21eae634d42fb2e27a1a381687a55be6ab1a662c`. It changes no application or daily adjustment workflow. The original two-file patch SHA-256 is `d765ebcae96acef9c2cfd98c735ee79a63f1709f40c8a98ae6519bcd02270bfe`.

The added cases exercise patient changes, abandoned renders, exact rebooking retries and captured reminders using synthetic React hooks and mocked network. Existing assertions remain. These are unit tests, not a PostgreSQL, real browser, server, or acceptance result; no success is claimed until they run.

The local execution attempt did not start Vitest because the isolated Node environment failed and shared disk fell below the safety threshold. The synthetic patch, local probe evidence and untracked dependencies remain outside this commit. The inherited branch also has unresolved prescription draft-print tests and older PostgreSQL CI failures. This branch is incomplete; do not merge or deploy it. A manually dispatched CI run must preserve every test and report actual results.

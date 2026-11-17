# WIP: bounded expense browser failure diagnostics

CI 44035896653 identified locations 78, 128 and 227 in the expense recovery browser suite; it did not expose the actual count, response status or reload error. The cause remains unknown. This change instruments the existing witnesses only, and does not alter their assertions or the product.

On a failed count poll it emits only expected and last observed integer counts from 0 through 10 (otherwise `other`). On an unexpected retry response it emits an allowlisted HTTP status (otherwise `other`). On a failed reload it emits `timeout` or `other`, checking only the error class name. Notices contain fixed labels and bounded classifications: no URL, identity, response, error message or raw data. A failed diagnostic output cannot replace the original failure; count and reload errors are rethrown unchanged, and the original status assertion remains.

Synthetic unit tests for the diagnostics and existing report sanitization/annotations passed 23/23. The three affected TypeScript files passed syntax transpilation, not a full typecheck. HTTP/browser tests were not run locally because of resource limits; this branch does not claim a CI pass. The line 116 shift failure and expense failures remain unproven until the corresponding real journeys execute.

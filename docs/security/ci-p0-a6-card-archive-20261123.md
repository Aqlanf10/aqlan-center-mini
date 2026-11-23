# P0-A A6 archive card — synthetic CI witness (23 Nov 2026)

PR #564 source head: `27e2a9aeb423a377149c245d35075df67fdd69f4`.
Staging source at audit: `df187a96727dc68e9f9349a8a8912b2a0b110d27`.

This CI-only push adds documentation only; verify no application/test file
differs from the source PR before transferring any hosted CI evidence.
Required witnesses: authorization before patient identity read; safe canonical
route ID; printed P-00042/P-07000/P-07001 without silent renumbering; portal
invitation removed; serialized clinical details absent from card.

Still requires independent PostgreSQL 18 patient-number high-water concurrency,
restore and archive/lookup tests plus a synthetic browser print acceptance.
Never run these against shared Staging or Production data.

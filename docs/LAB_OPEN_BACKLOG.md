# Open laboratory backlog: read-only first slice

This projection shows the current open population across all dates. It is not
limited to the leadership event day, financial period, or a capped legacy feed.
It reads existing records only and makes no clinical, scheduling, messaging,
financial, task-assignment, or status writes.

## Evidence and meaning

- `needed`: preparation / not recorded as dispatched. Age is from record creation,
  explicitly not a claimed sending date.
- `sent`, `in_progress`, `remake`: recorded as with the laboratory. Overdue means
  the saved expected arrival day precedes the captured current clinic day.
- `received`: recorded arrival, still awaiting clinical review / try-in / fitting.
  Age uses only `received_at`; missing or future-day arrival has unknown age.
- `delivered` and `cancelled`: excluded. Opening a patient file or completing an
  HR task never changes either a lab status or clinical completion.

The same patient may have several requests in different stages. The headline
counts distinct patients separately from requests and retains each request's
status and evidence. No delay is attributed to staff, a laboratory, or a patient's
absence without a corresponding source. Existing data without an order remains
outside the proven backlog and requires record review, not synthetic dates.

## Boundaries

The endpoint and data function both require admin access. The HTTP permissions
registry grants only admin GET. The response is private/no-store and the current
principal is checked again after reading. The clinical projection includes no
cost, currency, payable or commission data.

The SQL counts the complete five-state population, then enriches a stable
20-request page. The latest lab tracking event is independent from task assignment.
Only shared tasks and the current admin's own private tasks are eligible under
existing HR visibility rules. The first three visible active tasks per request
are displayed with a visible-only count. Missing visible tasks are not proof
that no task exists. Assignment labels, task deadlines and latest event actor
remain distinct; no person is automatically assigned or judged.

The page and response size are bounded, not the total work needed for exact
counts. The existing task-link indexes lead with task ID, so reverse lookup can
scan the link table once. The synthetic PostgreSQL performance test covers
20,000 orders and 100,000 tasks/links, verifies one query per read and at most one
full link scan, and reports warm timings. These measurements are not a
Production latency guarantee. No new index or migration is introduced here.

Patient links open the canonical patient laboratory tab. Task navigation opens
the existing task workspace; it does not pretend to select a specific task.
No appointment is inferred from a note or a later booking for the same patient.

## Separate work, not activated here

Robust saved invoice/plan-item to order membership, a same-order prescription
completion gate before `needed` becomes `sent`, historical source reconciliation,
and exact order-to-appointment links require separately reviewed contracts.
This slice does not add those identities, change prescription privacy, create
orders from financial acceptance, backfill old records, or alter commission rules.

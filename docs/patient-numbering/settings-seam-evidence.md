# Private settings save and receipt confirmation seam

Base `b1e5bc40ecf3640761942a4c66e5453447843d75`. The settings host renders the
real existing save component and forwards its explicit transport to a
server-side composition around the existing PostgreSQL same-client owner
session provider and preview-bound save controller. It does not add a
parallel write path, generic-admin fallback, production provider, signing
secret, Server Action, HTTP route, or mount in `app/settings/page.tsx`.

A candidate preview requires same-transaction owner proof, a fresh canonical
allocator snapshot and an injected trusted token issuer/validator pair.
Saving still delegates to the existing owner controller. The new current
read/receipt operation also requires canonical owner proof before/after the
read, looks up only that owner's exact request ID, and validates the
receipt intent and result against PostgreSQL revision semantics. It returns
separate **current** and **prior committed** values and never exposes the
reason, token or account identity from a stored receipt.

The tab journal writes only the non-secret request ID before an attempted
send. An exact same-page retry preserves its existing preview ticket. After
reload the host requests that exact receipt without retrying a write or
persisting a preview token. Missing, mismatched, unverifiable or unavailable
results hold the form, rather than suggesting that a second write is safe.
When the owner confirms the receipt through a fresh server read, the UI
explicitly distinguishes the previous saved result from the current next
number. No production browser stores any value because the host is unmounted.

## Why real authenticated HTTP acceptance is still blocked

The opaque proof must come from `readBoundRequestSession` inside an actual
authenticated Next request, paired with a reviewed persistent owner
binding loader and approved preview credential authority. No such deployed
binding/authority exists in this checkpoint. We did not fabricate a
cookie identity, generate a signing secret, enroll an account, or expose
a test-only Next route merely to claim HTTP acceptance. The scoped
PostgreSQL test uses an explicit in-process test double for owner/preview
claims and verifies the real controller, transaction, receipts, reconnect
and stale/ordinary-admin refusal; it is **not** canonical auth over HTTP.
The React host tests are component logic only, not a browser run.

Keep actual auth route activation, database-level old-writer fencing, and
an approved migration registry/writer lineage and exact backup verification
as release gates. A fixture token or historical receipt is not such a gate.
Nothing was uploaded, deployed, or run on a live database.

Final local verification: Node 22.23.3, 138 focused UI/journal/controller
tests, 18 PostgreSQL 18.6 tests (4 new settings and 14 prior adapter),
warning-clean lint for the new host, exact Next production build with
TypeScript passed. Built route manifest contains no numbering endpoint.
The owned PostgreSQL server was stopped. No browser or authenticated HTTP
pass claimed.

### Receipt at sequence exhaustion and asynchronous journal isolation

The dedicated PostgreSQL settings seam reserves and issues A-999999999999999999, then PostgreSQL refuses another issue (2200H). The exact authenticated owner's persisted save receipt still reads with `current.next: null`, and remains distinguishable from the active state after switching and issuing from B. No invented next number is displayed or returned. Same-prefix preview is disallowed by the UI and server policy. Unknown exact receipt still holds, including while exhausted. Snapshot corruption, revoked ownership, and unavailable read remain refusals, not evidence that an intent failed.

The private UI host invalidates callbacks by committed transport lifecycle and each read/send generation. Any actual receipt clear must also compare the exact stored request ID. UI regressions exercise delayed same-host reads, a transport replacement, a new journal ID, and a superseded first refusal. Only the request ID goes in tab storage. Missing receipt for a sent/lost/rolled-back request still requires an authoritative serialized disposition; elapsed time, missing row, closing the tab, or repeat reading does not supply that evidence. This patch does not implement a disposition route or mount the settings UI.

# Commission edit intent acceptance

The Settings Users API projection supplies a parsed advanced configuration even when
raw storage is SQL NULL. The ordinary party commission can therefore be 20% while
the projected advanced draft displays 30%. Opening that draft or saving Basic data
must not establish a new advanced policy.

The editor captures a fresh owner for every opening, even for the same user. Basic
and permission changes preserve the configuration baseline. An explicit financial
interaction creates a distinct draft, including deliberately entering zero, a
fractional percentage, or the same displayed value. Only that interaction includes
`commissionConfig` in the PATCH. Basic saves truly omit `commissionConfig`,
`commissionPercent`, and `clearCommissionConfig`; they do not send null or an
invented fallback. This page does not own ordinary party commission percentages.

Closing/reopening, switching accounts, and changing the draft role retire/reset
financial intent and an unadded service-rule draft. A failed save retains the
same-session draft for retry. A stale Save callback cannot submit, and a delayed
successful save cannot close an editor that was opened afterwards.

Percentage inputs use `step="any"` within the existing canonical 0–100 range.
No decimal-place restriction or rounding was introduced. Existing calculation
modes, parser validation, permission behavior and server errors remain authoritative.
The writer and its baseline/history/audit code are unchanged.

## Legacy map-only restriction

The current parser is not idempotent for a map-only legacy configuration. A synthetic
input such as `{ defaultPercent: 17, serviceRates: { "7": 41.5 } }` is parsed into a
configuration containing that map plus `customServiceRates: []`. Parsing that result
again treats the empty array as authoritative and reconstructs `serviceRates: {}`.
The validator returns the first parsed value, so dropping the array only in a UI
request does not solve the stored JSON/read round trip. Re-saving the resulting
array-plus-map JSON can lose the legacy rule on the next read.

The editor detects the legacy map in the original GET projection before reparsing.
It marks financial controls read-only, explains the restriction, permits Basic-only
omission, and defensively rejects a dirty financial Save even if a disabled control
is invoked programmatically. It neither converts maps nor broadens matching.

The direct resolver treats a numeric legacy map key as a service ID and excludes
that key from textual-name fallback: key `"7"` matches service ID 7, but does not
match a different service merely because its name is `"7"`. The actual report path
already calls `resolveLegacyServiceRateNames`, which converts a numeric legacy key
into a modern rule with `serviceId: Number(key)` while retaining the raw numeric
key as `serviceName`. It does not replace that name with a catalog name. The
adapter can resolve an unambiguous textual rule name to a catalog service ID.
Direct-resolver and report behavior are distinct;
this UI change preserves both by leaving the server path unchanged. These are
synthetic source-contract examples, not an estimate of Production impact.

A separately reviewed canonical preserve-absence fix could omit the synthesized
array only in the legacy-map branch. An explicitly supplied empty array remains
authoritative; already-stored empty-array-plus-map JSON must not be resurrected.
Embedded rate-history semantics and the separate prototype-named service-map issue
need their own review. No historical records are rewritten by this UI slice.

## Display truthfulness

The advanced editor calls its values a draft and says that the draft may differ
from the currently effective policy. Category inheritance, general percentages,
and the custom-rule table use draft wording. Opening a draft and saving Basic data
do not change the financial policy; an explicit financial save takes effect at the
server-owned event-time cutover. The DTO cannot identify raw absence, so accurately
showing the current policy would require separately owned canonical metadata. The
existing account-list display is outside this slice.

## Acceptance sources and validation status

The actual-page callback suite contains 23 cases. The category component suite
contains 9. The real built-app suites contain 8 browser cases, including:

- Basic omission with raw SQL NULL/ordinary 20%, actual earlier invoices, items,
  signed visits and payments, and unchanged old earnings/history/audit
- Explicit zero, 12.345%, and deliberately returned-to-30% drafts, with only the
  successful financial save creating server-owned baseline/cutover/audit
- A real failed-save/retry path preserving the draft; a delayed successful save
  leaving a newer editor open; cancellation, account switching and role reset
- A legacy map-only fixture with real old facts and 4150 earnings, all identical
  after Basic Save
- Exact raw-category edits, preserved legacy/custom keys and modern special rules,
  fractional/zero inputs, reopening, RTL layout, focus and 44-pixel targets

Four additional PostgreSQL cases cover zero/fractional policies under both bases
using the existing writer. They preserve prior facts and the prior earned part,
then assert the engine's existing event-time selection and two-stage rounding for
later collections. The original published244 PostgreSQL cases remain intact.
Earlier nonzero facts deliberately keep an aggregate row. The separate zero-only
aggregate-row-absence contract belongs to merged prerequisite245's isolated test.

This source was reconstructed after the workspace reset from exact published244,
published247 and main66a7 source, then refreshed onto mainada6 after PR249 merged. It is not the byte-identical previously validated
candidate. The old 32-test/type/lint result does not validate this reconstruction.
Fresh independent review, exact-commit full CI, real PG/browser execution and
screenshot inspection are required. No runtime execution is claimed here.

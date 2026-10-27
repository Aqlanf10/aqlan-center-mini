# Invoice archive and additional-service UI contract

The saved-invoice card opens a small dedicated editor. The existing invoice list,
account totals, collections, agreement controls and patient statement are kept as
their existing authoritative readers. A separate archive list is documentary;
it never replaces or filters the financial ledger.

Archive/restore show current administrative state, financial eligibility, actor,
reason and revision. A missing migration or undecided unpaid-invoice policy is
shown explicitly and cannot be treated as an empty archive or successful write.

Adding one independent service previews service, doctor, tooth/surfaces/scope,
price, discount, original currency, plan/case linkage and planned clinical state.
The server preview owns eligibility and amounts. Confirmation sends exactly the
previewed body; edits invalidate that preview. Success names the additional
invoice and its actual date, with separate original and final print links.

Both operations use the existing IndexedDB financial journal through one new
`invoice-maintenance` command kind. A command is reserved before POST and restored
by the ledger wrapper after reload. Another patient, actor, tab or command cannot
reuse it. A missing/malformed/lost response keeps the same body and key. Only an
exact verified receipt or a matching durable terminal rejection retires it.
Archive no-op acknowledgements are checked against the request and current
version; the previous archive event is never mistaken for this request's event.

Synthetic headless React tests exercise real callbacks, preview invalidation,
storage-before-send, double-click/lost response/reload and response validation.
Pure tests pin restoration and cross-patient/actor/document/amount rejection.
No browser or production behavior is claimed without its separate evidence.

## Local verification

`ui-red.log` records the initial missing-module failure before implementation.
`ui-green.log` records the focused new UI/recovery tests together with the existing
grouped editor, command recovery and recovery-label suites (Node 22; synthetic
HTTP/storage/session only). `ui-lint.log` covers all new UI/helper/test files with
zero warnings or errors. The existing PatientLedger `previewOwner` hooks warning
remains unrelated and unchanged. The root task owns final typecheck/build and
any real HTTP/browser evidence.

The server now supplies the effective doctor and plan identity, including the
doctor inherited from a selected existing plan item. The preview displays those
values rather than interpreting an unselected doctor as unassigned. A synthetic
case pins an inherited doctor/plan that differ from the form choices.

Archive stale recovery accepts only the exact `version_advanced` proof tied to
actor, invoice, patient, action, reason, key and expected version, with a strictly
greater current version. No ordinary conflict or policy refusal clears an
uncertain request. Addition stale recovery requires the durable rejection's
matching server request hash. Missing readiness never implies an empty archive.

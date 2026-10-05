# Orthodontic parent read authority

## Bounded source change

The parent `PatientOrtho` previously awaited both response headers, parsed Ortho JSON before checking status, and retained old cases/contact/sign/booking state after errors. Its lifetime depended on patientId alone. The page keyed its workspace by patient but did not provide a principal/permission fence. Local forms and queued photo continuations could publish after their view or authority changed.

This change is confined to `components/PatientOrtho.tsx`. The existing APIs remain authoritative. The parent now owns a patient/username/role/permissions lifetime; a display-name refresh preserves that lifetime. Independent clinical/contact reads check current ownership before JSON and after body completion. Either current401/403 retires both grants immediately; a stalled peer cannot postpone denial. Ordinary contact failures withdraw contact-dependent booking/reminder controls while preserving valid clinical access. Malformed/wrong-patient case and patient identity payloads cannot grant a reference.

## Retained forms and command safety

Each local form has opaque workspace-owned values, queued Files and preview URLs. A rendered form view has a separate lease. Read refresh, timeout or ordinary failure may remove the view while preserving its draft; retry restores the same user values, including a selected custom wire, without reapplying fresh defaults. A case that disappears from the current authorized result cannot receive the retained draft. Its values are held without being rendered until that case is again available. Hard denial removes all clinical and draft contents from DOM. A genuine owner change/unmount disposes drafts and owned URLs.

Read generation and mutation tickets are independent. A successful response for a command already submitted under this owner may complete its own form after an ordinary read failure. Hard denial/owner retirement invalidates response publication and chained uploads. Browser cancellation does not roll back a server write. An uncertain result remains latched to prevent another command from being submitted by a GET retry or duplicate event. All stored clinical/financial algorithms remain unchanged.

Preview URLs are released exactly when their queued photo is removed or consumed, the form is deliberately discarded, or the workspace owner ends. Temporary view cleanup does not revoke a still-retained preview. File additions/removals are blocked while the submission snapshot is busy or uncertain.

## Missing cases and completed local commands

Every new chained upload requires current membership of its case, including after a deferred adjustment response or an earlier upload returns. A current authorized empty case list can withdraw that grant while the mutation ticket remains valid for its already-sent request. The unsent photos remain retained, and the incomplete workflow is latched without retrying the adjustment or implying a rollback.

Signing and booking commands consult the live draft's completion state. The booking card has a separate form-view lifetime: Back immediately retires old submit/input/Back callbacks, and reopening gets a new view while retaining date/time. Saved booking/reminder data and saved-derived sign references are hidden while the saved case is missing; same-case recovery restores the opaque stored state without resubmission.

## Canonical compatibility

Case, plan, session, wire, elastic, follow-up and baseline defaults are unchanged. Existing signing body, signed history, retention/completion prompts, cancellation semantics, package classification, link/unlink requests and financial calculations remain unchanged. Photo read visibility and upload permission remain separate. No API, database/schema, financial writer or Production data changes are part of this slice.

The classifier integration contract intentionally changes: it no longer publishes funding references while its containing parent case read is unavailable. Independent classifier failure/retry behavior remains tested under an authorized successful parent read. After the parent retry, exact INCLUDED/OUTSIDE classification and agreement link/unlink semantics are still required.

## Verification gates

All newly authored acceptance is initially UNRUN and requires the exact candidate’s full CI.

- Synthetic actual-component tests cover paired header/body races, new lifetimes, display-name stability, stale handlers, draft/queued-file retention, mutation sequencing, duplicate events and malformed successful adjustment IDs
- A separate real React development StrictMode fixture mounts the actual SessionProvider, PatientOrtho and all local forms; only peripheral child modules are stubbed. It uses an in-memory test bundle served through isolated interception, with separately delayed headers/body and transport that deliberately ignores abort. It adds no application route or dependency
- The built-app isolated HTTP/browser journey uses real initial/retry patient/case reads at1280/390, shows denied and unavailable content withdrawal, restores the user draft, verifies keyboard retry/hit geometry, captures only two synthetic screenshots, and compares full case/adjustment/visit/document/plan/installment/payment/invoice/appointment rows before and after. Browser writes are blocked except one explicitly captured rejected form submission
- Existing cancellation, wire/regimen defaults, photo visibility, package read-state and classifier regressions remain required
- The old-source negative control must fail semantically because stale references remain present, using the pre-existing child onChanged refresh route rather than relying only on newly introduced test selectors

## Explicit remaining boundary

This does not certify every descendant or advanced Orthodontics. `PatientCeph` has a separately open post-unmount navigation continuation in its own create-study handler. Package, diagnosis and record-grid owners remain unchanged. A dedicated bounded PatientCeph lifetime review is still required; no imaging or treatment algorithm is rebuilt here.

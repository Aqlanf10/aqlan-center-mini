# Local periodontal workspace integration contract

`PeriodonticsWorkspace` is a client-only, patient-context component. This source addition does not enable the previous DentalChart periodontal editor, create any visit/case, sign a visit, or create procedures/invoices.

## Required props

- `patientId`, `patientName`: existing patient identity
- `authorityKey`: a stable key for the current login/clinical authority; change on any identity/permission change. The wrapper remounts on patient, authority or editable change and aborts prior requests
- `currentVisit`: null or `{id, patientId, date, signedAt, caseId}` for the actual current existing visit. No default visit selection is performed
- `editable`: presentation-level write permission; server routes remain authoritative
- `contextStatus`: `loading | error | ready`. Ready means visit, real doctor options and patient clinical-case context have all been successfully resolved. Failed reads must not be represented as empty ready arrays/null visit
- `doctors`: actual `parties.kind=doctor` options `{id, name}`; never substitute recorder/login/coordinator
- `cases`: `{id, patientId, title, specialty, status}`. This component filters choices to same-patient active/waiting periodontics cases; the server validates again

## Optional props

- `contextError`, `onRetryContext`
- `visibleToothCodes`: FDI display filter only. Every persisted site remains in the full PUT snapshot, and retained hidden teeth can be revealed
- `onDraftChange(pending)`, `onBusyChange(busy)`, `onNavigationGuardChange(guard | null)`: register with the existing shell controller. Invoke the registered guard before ordinary shell section/visit/patient/focus/sign navigation that would discard or bypass this draft. The guard blocks busy changes and prompts for pending edits. It also protects internal exam selection and `beforeunload`. An authority revocation is a privacy boundary: immediately redact/unmount without waiting for discard approval
- `onPersisted(exam)`: called only after the route confirms a save/addendum or after an uncertain PUT is reconciled to an identical canonical saved snapshot. Refresh persisted summaries without remounting the patient or replacing other specialty/clinical drafts

## Containment and recovery

Same-patient parent `currentVisit` changes do not reset a pending draft: the component freezes it against its captured visit/case/revision and requires an explicit discard/open-current action. Clean context changes adopt the new existing visit. Ordinary patient navigation requires the caller's existing navigation guard before changing props. Authority revocation must immediately redact/unmount, even with dirty or busy work; never keep revoked clinical data visible pending discard approval.

A definitive 401/403/404 from this workspace's own GET, mutation or reconciliation read redacts prior exams, selections, observations and pending addenda, and fences late replies for that controller instance. The user can leave normally; recovery requires fresh reopening or a new authorized instance and a successful canonical read. Aborting a client request does not prove that a server write was cancelled. A transient network/500 read failure retains only a visibly stale, read-only snapshot until a successful canonical read under the existing authority.

Ordinary successful GET refresh never overwrites pending observations. PUT uses full explicit snapshot and exact revision. Conflict/uncertainty reloads canonical history; comparison exposes provider/case and cell differences. Rebasing onto the reviewed revision is an explicit user action that does not save. Signed/history records are read-only; signed-only corrections use append-only addenda. An uncertain addendum keeps its original key and exact attempted text, reloads, and can replay that same request. Matching an existing addendum's text does not confirm its identity.

The controller is independently testable through injected same-shape API methods. The UI/controller tests do not constitute built HTTP/browser or signed-isolation proof. Do not enable production entry until the root integration, aggregate type/build, HTTP authorization and browser round-trip/navigation gates pass.

# Patient navigation coherence

The five patient tabs and existing treatment workspaces are views over existing clinical and financial objects. This change synchronizes those views with the active page URL; it does not create procedures, plans, appointments, charges, or payments.

## Bounded changes

- Canonical tab/subtab parsing retains the existing legacy aliases, including `ceph → ortho`.
- Summary's Ortho shortcut opens Ortho specifically, with one guarded URL update.
- Tab/subtab selection survives reload. Unrelated query parameters and fragments are preserved; no new unused object IDs are introduced.
- Explicit tab changes use replaceState only, preserving page-level Back/Forward behavior without creating a new tab-history feature. A rejected leave does not change the URL or unmount the draft.
- Mount synchronizes the rendered view to Next's committed URL, including client-side entry whose URL changes after initial rendering.
- The patient workspace is keyed by patient ID, so a different patient cannot inherit its local loaded state.
- Optional ENDO callbacks open Today's Visit, Plans, or Account. Account is passed only when the server-derived financial authority allows it. These are honest section links, not exact planned-item selection or execution.
- The ENDO component owns its leave guard. The parent invokes it once; its synchronous busy lock refuses navigation during a save. The existing dirty callback remains a compatibility fallback.
- Legacy `/visits/{id}/clinical` page links redirect to `/visits/{id}`. The existing proxy and canonical visit API retain authentication and patient authorization.

## Guard scope and verification

The URL adapter guards explicit in-page tab/shortcut actions only. It adds no traversal listeners, Navigation API interception, history indices or rewind logic. Browser Back/Forward remain page navigation; this slice does not guarantee preservation of unsaved drafts during cross-page/client-side navigation or browser traversal. Existing document-unload warnings are unchanged, and `beforeunload` is not a guard for arbitrary Next client-side links. A separate encounter-draft/navigation contract is needed before exact plan-item handoff between Today and ENDO.

Unit tests exercise the actual adapter, legacy parsing, query preservation, cancelled/accepted explicit actions, repeated busy-guard refusals, same-view reconciliation, committed-URL initialization and operation without Navigation API. The security-HTTP journey covers the real built application, explicit ENDO leave/save guard, login/patient authorization and desktop/mobile screenshots, using only the existing isolated test harness.

## Reference pattern

- [Dentrix Ascend patient ribbon](https://hsps.pro/DentrixAscend/Help/Quickly_navigating_patient_records.htm): persistent shortcuts between the same patient's clinical, planning, financial and document areas.
- [Open Dental Procedure Info](https://opendental.com/manual/procedureedit.html): the same procedure can be opened from Chart, Account, Treatment Plan or Appointment.

The current bounded change fixes section navigation only. Exact object focus, reciprocal source links, summary invalidation after writes, and planned-work execution semantics remain separate reviewed work.

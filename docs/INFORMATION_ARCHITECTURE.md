# Information architecture

## Design principle

Large dental systems do not expose every screen as an equal top-level item. Open Dental, for example, describes a single main window organized into seven task-oriented modules, with patient selection shared across modules. Its appointment and account work stays within those contexts rather than becoming a flat list of unrelated screens:

- https://www.opendental.com/manual/modules.html
- https://www.opendental.com/manual/appointments.html
- https://www.opendental.com/manual/mainmenu.html

The useful lesson is the hierarchy, not the feature count. Aqlan Center Mini should remain smaller and role-focused.

## Approved navigation hierarchy

| Module | Primary destinations | Notes |
| --- | --- | --- |
| Home | Dashboard | Summary and alerts; cards link into the owning module |
| Daily operations | Today, Appointments, Follow-up | The reception loop in chronological order |
| Patients & clinical | Patients, My work | Search and patient selection are shared; visits, work items and patient finance stay contextual instead of becoming duplicate top-level lists |
| Finance | Overview, Receipts, Payment vouchers, Commissions, Financial reports | Daily money workflow; exactly one link per register |
| Partners | Labs, Suppliers | Parties and their operational documents/statements |
| Administration | Services, Treasury accounts, Expense categories, Staff, Clinic settings, Audit log | Low-frequency setup, separated from daily work |

## Navigation rules

1. Render section headers for business modules; Home remains the single ungrouped dashboard link.
2. Order links by daily frequency, not by implementation date.
3. Configuration pages never appear among daily financial transactions.
4. A parent route is active only on its exact page when a more specific child link exists. `/finance` must not remain highlighted while `/finance/receipts` is active.
5. Desktop and mobile navigation use the same `NAV_ITEMS` definition and the same role filter.
6. A role sees only modules containing at least one permitted destination.
7. Reports are reached from the module they report on; do not add duplicate links to the same report.
8. Patient-specific actions remain in the patient record to preserve context and reduce accidental work on the wrong patient.
9. New destinations require an update to this document and an accessibility/mobile test.

## Page-level tabs

- Use tabs only for views of the same entity or workflow state.
- Do not use tabs as a second global navigation system.
- A patient record may group Summary, Visits, Appointments and Finance because all share one patient.
- Finance registers remain separate routes because they have different permissions and document lifecycles.
- Settings may use a settings index later, but each settings route keeps a stable URL for authorization and direct links.

## Implemented navigation baseline

The shared desktop/mobile navigation now follows the hierarchy above, uses
most-specific active-route matching, applies one centralized role filter and
has unit tests for grouping order, role visibility and active selection.
Arabic/English browser acceptance at 390 px remains part of the deployment gate.

# Compact patient clinical workspace

This presentation-only slice makes Today and Treatment usable as working screens. Summary retains the full patient overview. Existing clinical, scheduling, financial and authorization behavior is reused unchanged.

- One compact patient context strip contains exact identity/file number, alerts, current visit status, existing primary visit/readiness/chair controls and a disclosure for all current secondary actions
- Both compact and full patient context strips stay in document flow; neither competes with the application's existing sticky header or overlays the editor/navigation. This also preserves Summary → Treatment/Today click reachability after scrolling
- Full patient details and actions remain one explicit click away. Medical alerts, patient flags and abnormal recorded blood pressure remain visible when the details panel is closed
- Role-projected balances remain separate by currency; compact mode does not repeat the full header's balance blocks
- Five main destinations stay visible in compact navigation. Treatment uses a native section selector on mobile and a short button row on wider screens instead of eight large tiles
- The existing navigation/ENDO draft guards remain authoritative. Opening patient details does not unmount the specialty editor
- Bottom safe-area padding and control scroll margins keep the clinical form reachable above the app's mobile bottom navigation; the built-app journey checks keyboard access and hit testing at Save

The approach follows the compact shared-patient ribbon in [Dentrix Ascend](https://hsps.pro/DentrixAscend/Help/Quickly_navigating_patient_records.htm) and the shared-context views in [Open Dental](https://opendental.com/manual/procedureedit.html). It does not introduce another patient record, procedure, plan, billing form or request.

Acceptance requires actual built-app screenshots at 1280px and 390px, entry visibility for a normal fixture, full alert/long-name visibility, currency/role projections, access to secondary controls, and mobile Save/keyboard access. Long clinically important alerts may legitimately consume extra space; they must not be hidden to satisfy a height target. Local static rendering and unit tests are not visual or Production proof.

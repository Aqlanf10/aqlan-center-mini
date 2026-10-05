# Raw service category display

Authorized service POST/PATCH accepts free category strings. Prototype-property
names are therefore reachable stored values. An inherited dictionary value must
not be treated as a known label or rendered/serialized as a function or object.
Unknown `Constructor` must also retain its spelling rather than being normalized
because `constructor` happens to exist on Object.prototype.

This change uses own-key lookup in two ServiceSelect presentation boundaries and
only the categoryLabel expression in commissionDetailReport. Known labels and
existing clinical display normalization remain; unknown categories keep their
raw text. It does not change financial category keys, policy/default percentages,
accrual calculations, permissions, schema, financial writers or historical rows.

## Current-main integration boundary

The refresh is based on main 210a9e20b78407ea5573348e59ca2a5752f2dac7.
The complete captured-shift payment admission implementation and all 18 cases in
payment-shift-admission.test.ts remain unchanged, along with current commission
parser/history work, Today readiness, route enum admission, the strict checkout
restoration journey and clinic-relative independent referral fixtures. The
unmerged historical reconciliation preview is not included in this change.

Exactly six paths are involved: ServiceSelect, the one DTO-label expression in
lib/db.ts, the SSR regression, the HTTP/browser regression, this document and the
narrow two-image upload appended after the entire unchanged current workflow.

## Tests and fixture lifecycle

The unchanged SSR file contains 14 cases: five raw-name normalization/label cases,
five selected-service real-React SSR cases and four known/legacy controls.

The built-app file contains eight authorized service POST/commission-detail GET
cases and two RTL Account manual-selector journeys at widths 1280 and 390. Its
fixed synthetic 17% policy requires exact 1,700 commission on 10,000, string labels
and unchanged own-doctor/patient policy history, invoices/items, signed visits,
procedures and payments. The browser never submits the invoice; its page blocks
mutations and external requests. The two PNGs show the final selected raw label.
Their bounds and single-center native hits are bounded selector/label evidence,
not a whole-page or multi-point visibility guarantee.

Teardown always attempts deactivation of only the service IDs created by this
file, even when browser.close rejects, and then attempts db.end in a nested
finally. Errors are not swallowed. Database failure can still prevent successful
deactivation; this is a control-flow guarantee, not unconditional cleanup success.
No extra table cleanup, historical deletion, global deactivation or retry is added.

The HTTP harness recreates a disposable database and launches a built server.
Its approved ephemeral database destination must be established before global
setup. In-file checks of the browser host and database pathname are not enough
by themselves. No Production or shared-database execution is authorized by this
test source, and no global harness change is part of the repair.

## Evidence status

Historical PR246 predecessor 4c061065 passed the 10 label HTTP/browser cases but
failed the full gate on the separate strict checkout-restoration journey. Stale
head 4800ae62 failed before HTTP on two old internal-referral PG fixtures. Those
runs remain failures; their tests, screenshots and older local 14-case passes are
not fresh acceptance for this composition. Current main has later strict-journey
and corrected-referral passes, which are baseline context rather than a successor
guarantee.

At source-refresh preparation, no fresh local runtime, DB/browser run, full CI or
Production verification is claimed. Release requires independent source review,
fresh exact-head full CI including all 18 preserved cash-shift cases and all 10
label cases, inspection of both fresh PNGs, no review blockers, and coordinated
merge plus exact-commit Railway/native-health verification. The display fix does
not close every custom-category consumer or provide a historical correction tool.

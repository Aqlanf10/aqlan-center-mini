# P0-B clinical laboratory dispatch — synthetic CI witness (23 Nov 2026)

Source code: `5750b8d01056b688abce3e5ff8e235c058447349` in PR #565.
Deployed Staging baseline at audit: `df187a96727dc68e9f9349a8a8912b2a0b110d27`.

The only added content on this CI-trigger branch is this documentation witness.
The laboratory print route and synthetic test source are identical to PR #565;
verify through a tree/file comparison before treating a hosted CI result as
acceptance for PR #565.

Expected direct-denial: reception/assistant/cashier/accountant and anonymous
must fail before clinical order lookups; doctor/admin must still reach the
scoped order path, and doctors without ownership must not reach output.

Release is blocked until exact source/CI, PostgreSQL 18, built HTTP/browser,
print/privacy and authorized workflow checks pass. No real patient fixtures,
secrets, production or shared staging DB may be used.

The witness itself does not authorize a merge or a Staging deployment.

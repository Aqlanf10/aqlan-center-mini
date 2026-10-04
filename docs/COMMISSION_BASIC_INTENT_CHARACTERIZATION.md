# Basic doctor edit: absent advanced commission policy

This testing-only branch characterizes a pre-existing bug. No product, parser,
financial resolver, database, schema, permission or account-selection policy is
changed. Passing characterization tests describe incorrect current behavior;
they are not acceptance tests for the eventual fix.

The actual `listUsers` projection parses raw SQL NULL into a default advanced
percentage configuration with `defaultPercent: 30`. The actual Settings Users
Basic save handler includes that configuration whenever the edited role is
doctor, including a display-name-only change. The financial resolver correctly
uses the ordinary party percentage when advanced configuration is absent, but
uses advanced configuration when it exists. Thus a doctor with ordinary20 and
raw NULL can be switched to advanced30 by an unrelated name edit.

Executed locally under Node22: the actual Users page/hook scheduling test passed
two cases. The first edits the actual Basic name input and invokes the actual
Save callback; captured PATCH includes30 despite ordinary20/raw absence. The
second protects an already explicit advanced17 control. Only React scheduling
and fetch boundaries are synthetic; the page, parser and policy resolver are
actual imports. No writer/database is emulated in this local test. Scoped lint
passed for both authored files. Local PostgreSQL connection/build are unavailable;
no actual PostgreSQL/browser result or live-site incident is claimed yet.

The prepared built HTTP/browser characterization uses the existing isolated
security harness, a unique raw-NULL doctor/ordinary20 party and synthetic financial
facts. It compares a true omitted-config display-name PATCH (NULL/history/audit
and earnings unchanged) with an actual mobile Settings Basic save (captured30,
stored30, ordinary party20 still intact, baseline+advanced history and actor audit).
The same report must keep a previous invoice/payment at2000 earned out of10000
while new post-save facts earn3000. Complete old invoice/item/payment/visit rows
must remain unchanged. A closed synthetic shift avoids shared open-shift ownership.
This file must run on the actual built app and PostgreSQL18 before conclusions
about persisted behavior are made. It deliberately fails if the later fix removes
the bug; convert it to unchanged-policy acceptance expectations then.

The HTTP route and `updateUser` already support omitted advanced configuration:
an unrelated patch leaves raw NULL intact and does not enroll financial history.
A proposed bounded UI fix can capture an initial config object for the editing
account/modal lifetime, then include config only after an explicit commission
edit changes its identity. All current commission callbacks create a config
object; Basic/permission changes retain its identity. Capture account/form/baseline
coherently in the save render and reset on reopen/new account. Do not infer absence
from numeric/default equality, alias categories, change rates, backdate history,
or change shared-account selection. Product edits require independent source
review and authorization after the real-runtime characterization.

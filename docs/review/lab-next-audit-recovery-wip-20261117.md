# WIP: restore the published Next security pin to the lab branch

This local review branch starts at lab head `32febf7de196c923883af2eddbc8a1abc85ed207` and restores only `package.json` and `package-lock.json` from published security branch head `9abbfe0f902fd61599118586b0123c9016da67ce`. The lockfile changes are confined to Next, `@next/env`, the Next SWC platform packages, and the root Next declaration. Audit policy, CI steps and tests are unchanged.

The Dependency audit job in CI `44047812568` failed on the direct Next dependency, locked at 16.4.2: the sanitized report contained one moderate advisory, `GHSA-mfr8-8qww-v76h`, with affected range `>=16.3.0 <=16.4.4`. The restored manifest and lock pin Next 16.4.5 and match the published security branch byte for byte.

Read-only local validation: JSON manifest/lock consistency passed; `git diff --check` passed; `npm audit --package-lock-only --json` returned zero vulnerabilities for both the full and production graphs. The locked graph audit does not inspect the installed runtime and does not replace `npm run ci:audit` or fresh CI. No build, database test, or current-head CI was run for this local change. Prior security-branch CI `43996863431` passed its quality/audit/build job but failed PostgreSQL and HTTP jobs; do not infer full CI success from the security pin. Registry advisories can change.

Review WIP only; do not merge or deploy. No patient or production data was used.

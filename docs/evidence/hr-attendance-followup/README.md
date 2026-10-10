# HR follow-up executable evidence — PR #308

All screenshots and records here are synthetic, local and isolated. They are **not staging acceptance**. Application/test source is frozen at `07f39992563255ecb329731837f0ee109d35a784`; later delivery commits contain documentation/evidence only. The final delivery SHA and completed exact-head CI links are in PR #308.

## Before/after

- [PostgreSQL baseline](postgres-before.txt): the identical final workforce test file on `git archive` of `2763bc6018dd253e604bd1b7240f1a7206662a4f` fails **10** cases; **12** pass. Real writers run on separately owned PostgreSQL 18.6 fixtures.
- [PostgreSQL repair](postgres-after.txt): all **22** pass on a clean archive of the frozen repair with identical dependencies, configuration and unchanged 30-second setup deadline. This includes both missing-raw directions, exact/legacy night replays, late physical evidence after the next shift completes, cancellation with pending/rejected/approved history, double cancellation and the subsequent physical punch.
- [Browser baseline](browser-before.txt): both viewport regressions fail on the original built attendance component because independent date inputs do not exist; the other five cases were skipped.
- [Browser repair](browser-after.txt): final-source production build, real HTTP writers and independently authenticated synthetic second reviewer. Assertions cover approval and final display, SQL approval actor and preserved raw evidence, self-approval/replay rejection, reception/doctor permissions and employee spoofing at 390 and 1280, plus salary/percentage/hybrid settlement and existing strict permission/private-task journeys.

The original browser stop was a response-body wait after committed HTTP 201: the client never read the success body. The UI now reads and validates creation/decision JSON; tests retain their actual HTTP body and durable-state assertions. The role tab's accessible name includes its icon; the corrected selector and authenticated-role assertion check the actual UI. The private task test awaits its actual committed POST rather than a fixed 800ms sleep. No CI rule, timeout or permission assertion was weakened.

Two checkout PostgreSQL retries timed out during module transformation (one while the production build was active); their 22 cases did not execute. The clean frozen archive above passes under the original limits. These unsuccessful setup attempts are not counted as successful runs.

## Synthetic screenshots

| Journey | 390 | 1280 |
| --- | --- | --- |
| Explicit August 1 entry / August 2 exit | [form](hr-nextday-form-390.png) | [form](hr-nextday-form-1280.png) |
| Requester's self-approval denied | [pending](hr-nextday-self-denied-390.png) | [pending](hr-nextday-self-denied-1280.png) |
| Independent review approved | [approved](hr-nextday-approved-390.png) | [approved](hr-nextday-approved-1280.png) |
| Final 22:00 / 06:15, 8.3h display | [attendance](hr-nextday-result-390.png) | [attendance](hr-nextday-result-1280.png) |
| Reception attendance access | [reception](hr-nextday-reception-390.png) | [reception](hr-nextday-reception-1280.png) |
| Doctor restrictions | [doctor](hr-nextday-doctor-390.png) | [doctor](hr-nextday-doctor-1280.png) |
| Salary, percentage and hybrid fixtures | [payroll](hr-payroll-390.png) | [payroll](hr-payroll-1280.png) |

## Source migration inventory and staging limits

[HR checksums](hr-migrations.sha256) and [source Git blob inventory](source-migration-inventory.json) compare HR, ceph `eadd75028cbf35188d972a7521022522538c31d6` and fetched main `148fcbeac229cb279848e6ea37049d1599a4fafe`. These are source inventories, **not an applied migration ledger**. Existing HR migrations 0045/0046/0048/0049/0050 are unchanged; dot's reserved 0050 is retained. Ceph-only 0047 must survive composition. No common migration content conflict was found at these source references.

Dot retains publication responsibility for `staging-web` / `staging`. The user last verified ceph `eadd750` at https://staging-web-staging-0d39.up.railway.app. This session changed no external service, database or permanent account. The public health check was blocked by the outbound proxy, so deployed SHA, actual ledger, combined-source CI and post-deployment scenarios remain unverified. See [handoff](../../../HANDOFF_TO_DOT.md) for the proposed composition and acceptance steps.

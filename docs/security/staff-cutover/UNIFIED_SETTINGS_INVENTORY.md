# Unified settings — inventory (owner decision 5, Dot 6484846432)

Status: **inventory and plan**. It lists what exists on WORK, what is canonical, and what is missing. Everything is implemented inside the current architecture: the canonical capability document, the staff editor and the per-key settings policy. There is no parallel permission system.

## 1. Areas

| Area | Today (page / API) | Canonical status | Who may change it | Missing |
|---|---|---|---|---|
| Staff accounts (create, disable, profile) | `/settings/users`, `/api/users`, `/api/users/[id]` (legacy) | updates canonical (`/staff-access` → «الحساب», `/api/staff-access/[id]/account`); creation not canonical | `staff.accounts.create`, `staff.accounts.disable`, `staff.profile.edit`; role, credential and clinician link are owner-only | `CANONICAL_ACCOUNT_WRITES.md` §5: updates of existing accounts implemented for review (no schema change); creating an account in a ready identity needs a reviewed schema/lifecycle change (M4, B2) |
| Permissions (capabilities) | `/staff-access`, `/api/staff-access/[id]` | **canonical**: atomic CAS save, delegation limits, audit, protected owner | `staff.permissions.edit` within the editor's own authority | — |
| Starting templates | editor «قالب بداية» (`lib/staff-starting-templates.ts`) | **done**: fills the form only; nothing is effective until the owner confirms the account (`confirmation`, map §7 item 3b) | as above | assistant template (needs a "today's visits" scope decision) |
| Initial confirmation | editor banner and change preview | **done**: pending documents grant nothing; only the owner confirms; delegates maintain confirmed accounts within their authority | owner | — |
| Modules (visible / hidden) | editor module fieldsets (`lib/staff-modules.ts`) | **done**: hiding revokes the module's capabilities in one save; server-enforced | as above | — |
| Data scope (patients / appointments) | editor scope selectors | **canonical**: `none`, `own` (validated clinician link) or `all` | as above | a "today's visits" scope for assistants (owner decision) |
| Clinic identity (name, lead doctor, contact) | `/settings` → `/api/settings` | **canonical** (M2 slice 7) | per key: operational (`forReview`: report identity) | owner confirmation of the `forReview` keys |
| Operational settings (hours, capacity, scheduling, reception, display, clinical phrases) | `/settings` → `/api/settings` | **canonical** | `settings.operational.edit` per key | announcements manager (its own route) |
| Public waiting-room call and Arabic speech | `/display`, `/api/display`; central `/settings` + staff `/api/display/notice` | slice 27 implemented for review: minimum public projection; canonical read-only snapshot and separate notice CAS/audit | `settings.view` reads notice; `settings.operational.edit` edits privacy, local Arabic voice URI, rate (0.7–1.1), pause (0–1000ms), notice | real-device auditory check; canonical announcements CRUD remains separate. Old `display.show_ortho` never restores public workload metrics |
| Financial settings (currency, rates, prefixes, discounts, period lock) | `/settings` → `/api/settings` | **canonical** | `settings.finance.edit` per key | — |
| Authority-semantics keys | `/settings` → `/api/settings` | **canonical** | owner-only `settings.security.change` | — |
| Messaging / integrations | `/settings/messaging`, `/api/settings/messaging` | not canonical | owner-only `settings.integrations.change` | canonical write |
| Services, prices, plan templates, materials, lab services and prices, laboratories, expense categories | `/settings/appointment-services`, `/settings/plan-templates`, `/settings/material-rates`, `/settings/service-materials`, `/settings/lab-services`, `/settings/lab-pricing`, `/settings/laboratories`, `/settings/finance-expenses` | not canonical | `finance.service-prices.edit`, `finance.lab-prices.edit`, `clinical.laboratories.manage`, `settings.finance.edit` (map rows) | canonical branches per route (M2 step 7) |
| Patient numbering | `/settings/patient-numbering` | not canonical | `patients.number.manage` | canonical branch |
| Backup, import, export, reset | `/settings/backup`, `/settings/import`, `/settings/export`, `/settings/reset` | backup policy keys **canonical** (owner-only, via `/api/settings`); the screens and actions are not | owner-only `clinic.backup.manage`, `clinic.data.import`, `clinic.data.export`, `clinic.reset` | owner-only canonical branches with M4; no live destructive action is authorised now |
| Limited exports | report pages | not canonical | `reports.export`, `finance.export` (delegable) | canonical branches per report |
| Audit log | `/settings/audit` | not canonical (settings writes already audit with the canonical actor) | `audit.view`, `audit.export` | canonical read; settings history (`/settings/history`) |
| Readiness | `/settings/readiness` | not canonical | owner (map row) | canonical read |
| AI settings | `/settings/ai` | excluded (AI/Dot out of scope) | — | — |

## 2. One settings screen
The canonical shell gains a single **الإعدادات** entry. It is shown only when the account holds at least one capability of the settings, staff or audit modules, or is the owner. Its tabs:
1. **الطاقم والصلاحيات** — the existing canonical editor: accounts, capabilities, templates, modules, scopes.
2. **العيادة والتشغيل** — per-key edit. Each key is enabled only if the account may write it (`lib/settings-capabilities.ts`). The save is one atomic batch: an unknown or refused key refuses everything, the expected-version CAS applies, and the audit row is written in the same transaction.
3. **المالية** — the same mechanism for the finance keys.
4. **الخدمات والأسعار والمختبر** — the catalogue routes above, each migrated with its own capability.
5. **للمالك فقط** — authority keys, integrations, backup, import, export, reset. These are owner-only operations, never delegable.

Every tab is a projection of the account's current grants. The server re-proves each read and write, so a direct link or API call without the grant is refused.

## 3. Order
1. **Done:** the canonical settings read and the batch write for `/api/settings`, all key classes (M2 slice 7; PG `settings-canonical`, journey `canonical-settings-journey`).
2. **Done (first form):** the settings screen under the canonical shell (`/settings`, `settings.view`). The staff tab links to `/staff-access`. Tabs for the remaining areas are added as each one becomes canonical.
3. Account writes in the staff editor: updates of existing accounts implemented for review (`CANONICAL_ACCOUNT_WRITES.md` §5); creation with M4.
4. Catalogue routes (services, prices, lab), then the owner-only tab with M4.

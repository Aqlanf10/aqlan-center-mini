# Case responsibility: suggestion, reception display and grant-controlled confirmation

These are owner decisions recorded on #483 and #484 (2026-10-27):
- suggest the responsible doctor automatically, with the confirmation left to the administration;
- show the suggestion to reception;
- let viewing and confirming be granted from the settings.

This is a Draft over `review/canonical-staff-identity-20261027`. There is no merge or deployment, and no schema change.

## Behaviour
| Who | Default | What they can do |
|---|---|---|
| Admin | view ✅, confirm ✅ | Sees the current or suggested doctor; confirms or changes it (audited, with a reason) |
| Reception | view ✅, confirm ❌ | Sees «مقترح: د. X — بانتظار تأكيد المدير» in the booking form and the case panel. Cannot save unless explicitly granted |
| Doctor | view ❌, confirm ❌ | Nothing, unless granted |
| Cashier, accountant, assistant | — | Refused at the door: no patient-file route access |

**Suggestion source** (read-only, never written):
1. the single active doctor on the case's live plan items;
2. otherwise, the patient's active primary doctor.

When the items name several doctors, no name is offered and the message reads «تحديد الطبيب المسؤول مطلوب من الإدارة».

Booking still requires the recorded responsibility, re-verified at booking time.

## Authorisation (server, not the button)
- **Grants:** `DoctorPermissions.canViewResponsibilitySuggestion` and `canConfirmCaseResponsibility`. They live in `users.permissions`.
  - They are edited only by an admin in «الإعدادات ← المستخدمون» through `PATCH /api/users/[id]`, which is audited.
  - So nobody can grant themselves a permission.
- **Read path:** `patientResponsibilitySettings` revalidates the session in its transaction, then re-reads the actor's row with `FOR SHARE`, then requires patient access.
- **Save path:** the same steps run again before the write and before the audit row.
- **Why the re-read matters:** the session permission version only covers `financeAccess`. Without the transactional re-read, a confirmation window left open would keep working after the grant was revoked.
- **HTTP matrix:** `GET`/`PATCH /api/patients/[id]/responsibility` admit admin, reception and doctor at the door. The library decides the rest.

## Dependency on the canonical staff authority (WORK)
This uses the live permission mechanism. It does not add a parallel one, and it activates nothing from WORK.

When the canonical capability catalogue (`lib/staff-capability-catalogue.ts`, WORK) replaces `users.permissions`, these two grants need their own reviewed capabilities. Suggested names:
- `case.responsibility.view`;
- `case.responsibility.confirm`, with patient scope.

That migration belongs to the WORK cutover. It is not done here.

## Evidence (local, synthetic data)
| Suite | Result |
|---|---|
| `postgres/responsibility-suggestion` | 10/10. Covers: suggestion rules; default reception can view but not save (403, nothing written); a granted non-admin confirms, audited as reception; a grant revoked after viewing stops the save; doctor and cashier refused; booking context shows the suggestion, with no guessed name, and books after confirmation |
| `patient-responsibility-settings` (unit) | 15/15 |
| `patient-responsibility-settings-ui` | 10/10 |
| `patient-responsibility-settings-route` | 6/6 |
| `http-permissions` | pass |
| Built-app `responsibility-suggestion-ui` | 7/7 |

**The full browser journey** in `responsibility-suggestion-ui`:
1. Reception sees the suggestion while booking stays disabled; the case panel is read-only, and a direct save returns 403.
2. The admin grants confirmation from the users settings screen.
3. The grant is revoked while reception's window is open, and the save returns 403.
4. The grant is restored, and reception confirms.
5. Booking succeeds under the confirmed doctor.

**Regression:** the related built-app suites (return booking, ortho follow-up, invoice continuity, rebooking, permission matrix) pass, 34/34.

# Wire and appliance options in the adjustment session (spec; owner decision recorded below)

Owner directives on #483 (2026-11-13):
- 23:05 UTC: «خطوات جلسات الشد ما اريد تغيريها»
- 23:07 UTC: «ايوه شاشة الجلسات الشد فقط يضيف ويوسع الاسلاك والاجهزه»

Scope: add to and expand the wire and appliance options in the adjustment session screen. Do not change the
session's steps, its order or the daily flow, and add no new required step. Old records and old values stay
readable and selectable. No code before the owner confirms the open questions below.

## Today (integration head)

| Item | Where | Constraint |
|---|---|---|
| Wire select (upper/lower) in the session form | `components/PatientOrtho.tsx` `AdjustmentForm` | Options = the case slot's standard sequence (`WIRE_SEQUENCE` in `lib/ortho.ts`: 8 wires for 022, 6 for 018) plus the case's current and selected wires. Shown only for fixed appliances. |
| Wire storage | `ortho_adjustments.upper_wire/lower_wire`, `ortho_cases.upper_wire/lower_wire` | Free text. No server-side fixed list, so new codes need no migration. |
| "Next wire" suggestion | `nextWire()` over `WIRE_SEQUENCE` | Must not change: the sequence drives the suggestion. |
| Appliance type of the case | `APPLIANCE_LABEL` in `lib/ortho.ts`: fixed metal, fixed ceramic, clear aligners, removable, functional | Text column. The screens reject unknown values. Migration 0108's check allows a missing slot only for aligners, removable and functional. |
| Appliances in the session form | none | The session screen does not record an appliance today. |

## Proposal

### A. Wires (no schema change)

1. A separate full catalog, `ARCHWIRE_CATALOG`, grouped by material and shape. `WIRE_SEQUENCE` and the
   "next wire" suggestion stay unchanged.
2. The session's wire select stays the same control in the same place, with the same "no change" default and
   the same "remove wire" boxes. It lists the slot's sequence first, then the rest of the catalog in groups
   (`<optgroup>`). Any old saved code not in the catalog stays at the top, labelled as recorded.
3. Proposed catalog (inch codes, as the clinic already writes them):
   - NiTi round: 012, 013, 014, 016, 018
   - NiTi rectangular: 016×016, 016×022, 017×025, 018×025, 019×025
   - Heat-activated NiTi and CuNiTi: 014, 016, 016×022, 017×025, 019×025
   - Stainless steel round: 014, 016, 018, 020
   - Stainless steel rectangular: 016×022, 017×025, 018×025, 019×025
   - TMA (beta-titanium): 016×022, 017×025, 019×025
   - Braided or coaxial steel: 0175 braided, 015 coaxial, 019×025 braided
4. The doctor can also type a wire that is not in the list (an "other wire" text box). It is saved as text, as
   today. This is optional and does not add a step.

### B. Appliances (open question 1)

- **B1, case appliance type (applies at case start and in the case header).** Add types that use archwires
  without a schema change: self-ligating metal, self-ligating ceramic, lingual, sapphire. A non-wire type (for
  example, an expander used as the only appliance) needs a new migration number. That number must be
  allocated, because 0126/0127 are protected and 0128–0131 are reserved for finance.
- **B2, auxiliary appliances recorded in a session (optional, never required).** A multi-select under the
  wires: rapid palatal expander, quad helix, transpalatal arch, lingual arch, Nance, mini-screws, Class II
  corrector, open or closed coil spring, power chain, lip bumper, headgear, facemask. It needs one new nullable
  column on `ortho_adjustments` (a migration), with old sessions shown as "not recorded" and never as "none".

## Tests required before merge

Display, select, save and reopen at 390px and 1280px:
- an old session with an off-list wire still shows and saves unchanged;
- grants: doctor and admin can save; read-only roles see the values but get no control;
- a lost response is reconciled without a second session;
- the "next wire" suggestion is unchanged;
- session step count and order are unchanged: the before/after journey still measures 3 actions.

## Open questions for the owner

1. «الأجهزة» in the session screen: does it mean the case's appliance type (B1), auxiliary appliances added
   during a session (B2), or both?
2. Is the wire list in A3 complete for the clinic? Add or remove any sizes or materials.
3. Should the "other wire" text box be offered, or only the list?

## Owner decision (#483, 2026-11-13 23:17 and 23:20 UTC)

Approved: the full wire catalog with an "other" option; the usual sequence and next-wire suggestion kept,
with no automatic change to records; more case appliance types; optional auxiliary appliances with an
"other" option; old records kept compatible; visits first, with clear section names. Any migration is
coordinated with the other lines before its number is allocated.

Auxiliary list from the owner: Hyrax / MARPE, Nance Button, TPA, TAD / Mini-screw, Closed Coil NiTi,
Open Coil, Power Chain, Laceback / Bendback, Bite Turbo, Carriere Motion, Herbst, Forsus, Twin Block,
Lip Bumper, Lingual Holding Arch, Quad Helix, and "other" (free text).

## Status

- Done (`ef54ef1e`, `ff9d6da6`): A1–A4 (wires, including "other") and B1 (self-ligating metal and
  ceramic, lingual, sapphire). Visits are first again. Covered by unit tests and a built-app journey at
  390px and 1280px.
- Done on the integration branch (not yet pushed when this line was written): B2, the auxiliaries, with
  migration `0132_ortho_adjustment_auxiliaries.sql` allocated by Dot (#483 6867852606).
  - Storage: `ortho_adjustments.auxiliaries TEXT[]` and `auxiliary_other TEXT`, both nullable, no default and no
    backfill. NULL means not recorded (every earlier session), `{}` is an explicit "none". A CHECK (through the
    immutable function `ortho_adjustment_auxiliaries_valid`) accepts only the 17 owner keys, each once and in
    catalog order, and requires the «آخر» name (1–80 characters, trimmed) exactly when «آخر» is chosen.
  - Server: `parseAuxiliariesInput` (`lib/ortho-auxiliaries.ts`) refuses unknown keys, duplicates, a missing or
    over-long «آخر» name and a name without «آخر» with 400 `invalid_adjustment_auxiliaries`, before any write.
    Nothing is trimmed to fit. The replay fingerprint includes the list only when it is recorded, so earlier
    receipts keep their hashes and "none" differs from "not recorded".
  - Screen: a collapsed «الأجهزة المساعدة (اختياري)» section under the wires, unselected by default and never
    prefilled from the previous session; an explicit «لا توجد أجهزة مساعدة في هذه الجلسة» box; «آخر» reveals a
    text box. Clearing the last choice returns to "not recorded". The routine path stays 3 actions.
  - History: a line under the session when a list is recorded; the session details always show one of
    «غير مسجّلة في هذه الجلسة», «لا أجهزة مساعدة (سُجّل صراحةً)» or the list.
  - Only the adjustment-session screen writes the list; the visit-sign writer leaves it NULL.
  - Tests: unit `__tests__/ortho-auxiliaries.test.ts`; PostgreSQL
    `__tests__/postgres/ortho-adjustment-auxiliaries.test.ts` (real route: three states, refusals, replay,
    fingerprint compatibility, patient scope, constraint, re-initialisation) and
    `ortho-adjustment-auxiliaries-upgrade.test.ts` (populated 0126 → 0132, no backfill, re-run no-op); browser
    `__tests__/security-http/ortho-session-auxiliaries-browser.test.ts` at 390px and 1280px.

# Wire and appliance options in the adjustment session (spec, awaiting owner confirmation)

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

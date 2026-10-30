# Dental chart anatomy audit — 2026-10-28

## Scope and reference

The treatment area currently has TWO correct visual designs:
- Plan items/template/referral/visit: `ToothPicker`/`ToothField`, numeric cells.
- Clinical chart and invoice selector: `dental/Odontogram`, tooth glyphs with clinical condition and planned-state overlays.

This slice unifies anatomical rows, not an unconfirmed replacement of either visual design. A full visual redesign remains subject to the owner's reference clarification. No saved tooth identifiers or patient records are migrated.

## Inventory

| Renderer | Callers | Preserved specialty behavior |
| --- | --- | --- |
| `dental/Odontogram` | `DentalChart`, `ToothSelectionDialog` → `PatientLedger`, `InvoiceTemplatePicker`, `LegacyTreatmentForm` | Clinical conditions, missing/extracted marks, planned marker, unknown chart state, FDI/Universal |
| `ToothPicker` | `TemplatePlanForm`, `PatientReferrals`, `ToothField` → `PatientPlans`, `QuickPlanForm`, `ClinicalVisit` | Single/multiple selection, whole arch, max32, clear, primary toggle |
| `LabDentalChart` | `app/lab`, `PatientLabOrders`, `LabPrescriptionModal` | Roles/colors, bridge wizard, quick presets, context actions, summaries, readonly |
| `app/print/lab/[id]` | Dedicated dispatch print | External privacy projection, selection, technical warnings, primary arches |
| `PerioChartView` | `DentalChart` | Site measurements and unavailable/unrecorded safeguards; no new persistence enabled |

`SurfaceSelector` is a surface editor and retains M/O/D/B/L semantics. `PatientEndo` has a dropdown, not an arch. Dossier print lists clinical records, not a visual chart.

## Verified problems

- Lab split-quadrant rows inherited RTL while each quadrant was LTR: 21…28 | 18…11, with posterior teeth at midline. Fixed using whole canonical rows.
- Lab print adult rows inherited RTL, while primary rows were LTR. All now use the same row primitive.
- Lab bridge numeric interval could generate invalid 19/20 between 11 and21 and select unrelated teeth. Bridge span now uses same-arch/same-dentition canonical indices; incompatible endpoints are refused.
- Lab default permanent-only view hid saved primary selections. Primary selections now open mixed view, including after asynchronous value arrival.
- Old invalid parsed codes remain in their source map, explicitly warned about and never silently renumbered. External print's existing strict projection continues to emit its nonstandard-data warning.
- Periodontal rows wrapped one jaw into two rows on small screens; now a single scrollable anatomical row. Its recording-disabled safeguard is unchanged.

## Canonical contract

`lib/dental.ts` is the source of FDI order. `DentalArchRow` fixes the whole row to LTR and works both in client imports and server print without a client boundary. Specialty tooth cells remain separate until visual reference confirmation. Lab quadrant exports now derive from the canonical arrays.

Upper permanent: 18…11 | 21…28. Lower: 48…41 | 31…38.
Upper primary: 55…51 | 61…65. Lower: 85…81 | 71…75.

No external dispatch, account edit, patient write, Production settings change, or migration was performed for this slice.

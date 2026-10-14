# AQLAN patient workspace design contract

The approved 15-image gallery governs the patient-file presentation. This is a refinement of the existing clinical application, not a second application or a redesign of its accounting model. The working branch is `codex/patient-reference-fidelity-20261014`, based on integration commit `175957f4e074d28b819d00a51f3f1e6d53b3d78b` (not main).

## Source of truth

Runtime styles remain canonical: `tailwind.config.ts` for shared semantic colors, typography and focus; `components/PatientShell.module.css` for patient navigation; `app/patients/[id]/patient-premium.module.css` for the patient scope; component CSS modules for their own regions. This document records their intent and mapping, not another generated token system.

| Role | Existing implementation |
|---|---|
| Patient canvas | `#eff8ff`, patient root only |
| Surfaces / boundaries | White, `#d5e8fa`, 9–10px patient card corners |
| Navigation / selected context | Blue gradient, `--patient-blue: #0878d2` |
| Headings / ordinary text | Blue headings, `#174777` patient body |
| Main task | Existing orange action; blue for navigation and selection |
| Destructive / safety | Existing danger and warning tokens; text accompanies color |
| Type | Existing self-hosted Arabic font (`--font-arabic`); no remote font dependency |
| Density | 10–12px region gaps, 12–14px card padding, wrapping content |
| Touch / keyboard | 44px mobile action targets, visible focus, logical RTL properties |

## Layout and actions

The desktop has the approved 213px blue sidebar, clinic header, patient identity, complete safety context and five canonical patient tabs. Summary places separate-currency metrics before clinical context, selected-plan progress and the next action. Plan progress uses actual recorded procedures; an unknown historical progression is never illustrated as a completed stage.

One primary task belongs to each context. Secondary actions stay beside the object they affect. Summary collection lives in its account section, document actions beside the selected document, and audited document hiding remains distinct from upload. Detailed agreement/invoice amounts are disclosed per currency; the immediate due and agreement remainder remain visible. No cross-currency total is permitted.

At 1280px the desktop regions contract without clipping. At 390px cards stack, identity facts prioritize clinical context, and the existing mobile navigation remains available. Long warnings may increase header height; never truncate or hide them merely to fit the reference. Tooth geometry is excluded from generic action resizing.

## Canonical owners and safety

- `PatientCockpit` and its readiness hook own chair/readiness controls and current clinical warnings.
- `PatientLedger` and the existing collection/correction launchers own account workflows. The premium overview is read-only.
- `ClinicalVisit` owns notes, procedures, save/sign state and failures.
- `PatientDocuments` owns one gallery, uploader and selected preview/action group.
- Existing patient editors, history versions, chart, specialty workspaces and their server permissions remain authoritative.
- Existing patient navigation guards own draft retention, busy-state blocking and discard decisions. Layout work does not replace their synchronous contract.

Do not introduce another ledger, clinical editor, document gallery, authentication layer or financial writer. Do not create clinical facts to populate a reference image. Preserve loading, empty, denied, failed and retry states.

## Verification and evidence

Use the existing [reference workflow](docs/ux/AQLAN_REFERENCE_FIDELITY_WORKFLOW.md), [15-screen matrix](docs/ux/PATIENT_FILE_VISUAL_FIDELITY_MATRIX.md) and [review report](docs/ux/PATIENT_PREMIUM_REFERENCE_REVIEW.md). These are the detailed UX contract; do not duplicate them in another parallel checklist.

Build once, then run Playwright against the real isolated PostgreSQL-backed app at 1448, 1280 and 390px. Never rebuild `.next` while the HTTP harness serves it. Inspect actual images as well as test results. Pixel differences are diagnostic, not acceptance percentages; only desktop references were supplied. Use synthetic records only. Staging deployment belongs to dot; neither a local build nor a green CI run proves the deployed design.

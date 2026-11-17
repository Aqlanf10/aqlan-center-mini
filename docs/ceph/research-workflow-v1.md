# Synthetic research tracing workflow

Status: isolated, unmounted prototype; **not clinical and not release ready**.
Base: `4f7df3d404da96f6baf6a6de2dd932186c74a715`.

## Scope and ownership

`components/ceph-research/ResearchTracingWorkflow.tsx` owns a standalone Arabic RTL research surface. It is deliberately not imported by any application page. It has no image upload, arbitrary image URL, patient identifier, fetch, database, localStorage, or production adapter. The source is a generated 800 × 600 coordinate grid, not anatomical imagery. Landmark identifiers come from the research core; this UI does not assert that their clinical definitions have been approved.

`lib/ceph-workflow/research-workflow.ts` owns deterministic draft transitions and immutable in-memory review snapshots. This is not a clinical approval, durable save, audit log or server concurrency implementation. No legacy records or tightening-session files change.

## Design and canonical map

Product-tool register; the signature is a large original-coordinate tracing surface beside the ordered calibration/marking controls. Existing `DESIGN.md` and `tailwind.config.ts` remain the visual source of truth: navy structure, canvas background, warning research banner and success marking, local Arabic typography. No global token, typography, scrollbar, app-shell or existing component changes.

| Capability | Owner / choice |
| --- | --- |
| Numeric entry | Native number inputs; app validation; no native validation bubbles |
| Single select | Native select; OS popup geometry accepted for this bounded prototype |
| Mark placement | SVG source coordinate conversion via inverse screen CTM; numeric alternative |
| Feedback | Inline persistent error (`alert`) and completion message (`status`), as in existing inline forms |
| Review | Explicit per-point action; snapshot gate owned by pure workflow model |
| Persistence | None; explicit loss-on-close warning, in-memory snapshots capped at 20 |

This module does not reuse legacy `CephTracer` measurement/diagnosis/save behavior because it remains separate from that clinical surface. It reuses the research core landmark registry and geometry helper. It provides no report, classification or treatment recommendation.

## Interaction contract

1. Choose anterior direction explicitly; no inferred orientation.
2. Enter two original-image reference coordinates and positive synthetic millimetres. The isotropic scale is an engineering example, not evidence of patient-plane calibration or detector metadata.
3. Select a landmark and place it on the grid or enter original column/row. Reject missing, non-finite and out-of-range values rather than clamping.
4. Explicitly review each landmark. Editing a point revokes that point's review. Applying a calibration or changing orientation revokes all reviews.
5. Only a complete reviewed set creates an immutable synthetic snapshot. Duplicate capture of the same revision is prevented. Later edits leave older snapshots unchanged and label them as historical.

All snapshots retain `clinicalUseAllowed: false` and `calibrationScope: synthetic-only`. They must not be silently adapted to `patient-plane` or used to open the clinical core's distance gates. Cross-worker integration needs a reviewed contract.

## Verification and remaining gates

- Workflow unit + SSR tests: 19/19 passed; final regression with research-core and legacy-characterization suites: 99/99 passed across four files on Node 24.22.1 (project requires Node 22; CI remains required).
- Repository TypeScript passed again after final changes (`tsc --noEmit --incremental false`).
- Scoped ESLint passed.
- Standalone esbuild + Tailwind preview compiled locally.
- Chromium browser test attempt blocked at launch by `socket() failed: Operation not permitted`; no browser assertion executed. Cloud browser fallback could not reach local server (`ERR_CONNECTION_REFUSED`). Consequently, visual/responsive/keyboard and click-coordinate behavior are **not browser verified**.
- Full app build, full suite, hosted CI, premium static audit and staging were not run. The cloud skill package does not expose a local audit script path; no premium compliance claim is made.

Before mounting anywhere: test desktop/mobile/zoom and keyboard, interruption/refresh messaging, source-coordinate clicks, duplicate captures, invalid numeric entries, full-set review, edit/global invalidation, unchanged historical snapshots; add server authorization, secure image provenance, persistent versioned storage and genuine review/audit semantics through their canonical owners. None of those clinical integrations is implemented by this slice.

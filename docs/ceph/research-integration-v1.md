# Cephalometric research integration

Isolated local integration branch: `feat/ceph-research-integration-20261117`.
Not a deployment candidate, clinical validation, or patient-facing feature.

## Inputs and conflict review

All slices share base `4f7df3d404da96f6baf6a6de2dd932186c74a715`.

| Slice | Verified published head | Equivalent local input |
| --- | --- | --- |
| Engine verification | `300c304e471c691cb1caa2481f52af55a888cbba` | `2c2483e` |
| Research report | `c8507223038338ab484b4a82d15f990a1df6b9c0` | `57f17e1` |
| Synthetic workflow | `3c1dae1a4a1f25faa1fa007ebbef2d0e0a71c9c9` | `f3b3ce9` |

Local slice commits were cherry-picked into this separate branch. Original branches remain untouched. No file conflicts occurred: the engine modifies its core and adds verification; the report and workflow add distinct modules. The report reads the updated engine version dynamically.

## Calibration contract

`createSyntheticWorkflowReport` is a pure in-process bridge, not an API endpoint. It accepts the typed workflow snapshot, checks synthetic identity/scope, false clinical flag, valid revision/direction, valid reference, all ten reviewed in-bounds points, and reference-scale consistency. It recomputes the snapshot before mapping points to a new core study.

The synthetic image is isotropic. The bridge passes **ratio-only 1:1** calibration regardless of the example reference's millimetres. It never creates patient-plane provenance, confirms a clinical calibration, or opens physical-distance gates. Angles may be computed geometrically; distances remain unavailable with `uncalibrated-patient-distance`. No norms, diagnosis, treatment recommendation, patient link, database, upload, network request or storage is added.

The UI is still deliberately unmounted. This iteration combines sources and verifies a callable workflow-to-engine-to-report seam; it does not claim a completed visual end-to-end UI/report journey. The bridge expects an internal typed snapshot, not arbitrary hostile JSON; a future public API needs its own runtime schema and authorization.

## Evidence and exclusions

- Seven focused suites: **116/116 pass**, including five new cross-slice tests and legacy characterization.
- New integration tests check angular output, engine version, disabled distances/clinical interpretation, synthetic reference invariance, snapshot immutability, and rejection of forged scale/clinical flag, unreviewed/out-of-range points and invalid revision.
- Scoped ESLint and repository TypeScript (`tsc --noEmit --incremental false`) both passed (exit 0).
- Node 24.22.1 was available; project requires Node 22. Hosted CI is not claimed.
- Browser tests remain blocked by Chromium sandbox socket failure; cloud-browser localhost also refused. No screenshot/keyboard/mobile/click-transform or print-render validation is claimed.
- No full application build, full suite, PostgreSQL, migration, real-data, staging, production or clinical validation was performed.

Before mounting: independent scientific definitions/signoff, browser/print tests, secure image provenance and calibration semantics, persistent review/revision/audit safeguards, and integration-owner approval. Daily adjustment sessions and legacy patient workflows are unchanged.

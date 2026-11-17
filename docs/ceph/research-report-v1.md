# Research cephalometric report, slice 1

Status: research only, not for diagnosis or treatment. No application route, patient database, legacy report, calibration workflow, or adjustment visit is changed.

## API

`createResearchReport(study: unknown)` evaluates the versioned Steiner Core-8 input rather than accepting caller-provided measurement results. It exposes unrounded calculation values, separate two-decimal display values, group, definition expression, issue codes and evidence-review labels. An `ok` calculation is labelled as mathematical computation only, never clinical acceptance. Norms, diagnostic interpretations and clinical use remain disabled.

`renderResearchReportHtml(study: unknown)` renders a standalone Arabic RTL HTML document. Sections: research restriction; engine/study/geometry revision and declared calibration; skeletal calculations; incisor inclination; incisor crown positions; limitations; sources. It includes print CSS, repeated header/footer research warnings, semantic table headers and direction isolation. It has no scripts, external fonts, image requests, filesystem or network operations. Sources are links only.

The report deliberately omits patient identity, image URLs, arbitrary metadata and free-text calibration provenance. It shows only allowlisted calibration metadata and explicitly says calibration was not independently validated. A future secured report integration must supply authenticated, reviewed provenance rather than assuming arbitrary strings are safe or true. This slice does not implement patient reports, persistence, PDFs, approval signatures, export permissions, clinical dictionaries or historical comparison.

## Scientific evidence checked 2026-11-17

- Steiner 1960, original article hosted by BBO: https://bbo.org.br/bbo/files/bibliografia/artigos/56_The_use_of_cep_halometrics.pdf . The text differentiates the lower incisor reference NB. The case and historical reference figures do not validate this code or justify universal normative values. No historical numeric norms are enabled.
- DICOM PS3.3 2026b §10.7: https://dicom.nema.org/medical/dicom/2026b/output/chtml/part03/sect_10.7.html . Spacing is row then column. Calibration scope and anatomical depth cannot be established by a numeric pair alone.
- Definition limitations remain those in `independent-core-v1.md`: landmark review for every metric, incisor ray branches in atypical cases, and crown extremum definitions remain unresolved. This report must not elevate a numeric output into approved scientific evidence.

No `generateCephExpertDiagnosis`, legacy norm lookup, tolerance-as-SD conversion or automatic treatment suggestion is imported. Existing reports are not relabelled or recalculated. The version identifiers are carried into this newly computed research report only.

## Verification

Synthetic tests cover invalid input, missing landmarks, negative ANB, immutability, deterministic output, stale calibration, ratio-only restrictions, metadata non-disclosure and explicit research notices. Tests are engineering checks, not evidence of patient accuracy. Browser layout and actual printed pagination require separate visual verification before UI integration.

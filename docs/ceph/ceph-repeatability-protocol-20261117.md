# Blinded cephalometric repeatability protocol, draft 1

Status: research protocol only. No human image was accessed or traced for this document. No app behavior, calibration gate, patient workflow or deployment was changed. Clinical use remains disallowed. This is a proposed study, not evidence that the current program is clinically validated.

## Verified evidence and its limits

Damstra et al., 2010, DOI 10.1016/j.ajodo.2010.05.013, studied 25 digital lateral cephalograms, 11 angular and four linear measurements, two observers and three sessions separated by at least one week. Their abstract reports absolute-agreement ICC and smallest detectable differences, and cautions that apparently good reliability can coexist with potentially important measurement error. This supports measurement-specific error reporting, not a universal tolerance. The abstract's numeric error sentence is ambiguous; no numeric cutoff is adopted here. [Primary abstract](https://pubmed.ncbi.nlm.nih.gov/21055590/)

Lagravere et al., 2010, DOI 10.1016/j.ajodo.2008.07.018, examined records from ten adolescents and compared lateral cephalograms with formatted CBCT. Most coordinate ICCs exceeded 0.9, yet errors varied by landmark. Lateral-image difficulties included condylion, gonion, porion, lower-incisor apex and posterior nasal spine. This supports coordinate- and landmark-specific analysis, not treating a high overall correlation as proof of accuracy. Its small adolescent sample and modality differences cannot establish local adult or population-wide performance. [Primary abstract](https://pubmed.ncbi.nlm.nih.gov/20451778/)

Only the PubMed abstracts were verified. Both publisher full-text links returned HTTP 403. Detailed tables, recruitment distributions and full analysis methods therefore remain unverified. Obtain lawful full texts before importing their detailed methods or values.

## Relationship to current engineering work

Read `docs/ceph/research-integration-v1.md` and `research-workflow-v1.md` on `feat/ceph-research-integration-20261117`. They describe an unmounted synthetic grid, ratio-only calibration, unavailable physical distances and no patient adapter. Their geometric/unit tests do not measure examiner repeatability. This protocol does not authorize attaching real images to that prototype or bypassing distance gates.

Keep four questions separate: formula correctness; human repeatability; accuracy against an independently justified reference; clinical usefulness. A repeatable trace may be systematically wrong. Consensus is an adjudicated reference, not anatomical truth.

## Study preparation and privacy gate

1. A scientific reviewer freezes source-backed landmark definitions, construction rules, units, orientation, bilateral-contour rules, measurement formula versions and intended use. Explicitly distinguish Go-Gn from Go-Me; freeze the occlusal-plane definition for Wits. Do not reinterpret historical results.
2. Freeze build SHA, source image coordinate convention, transform/version, image modality, calibration provenance and study protocol. Geometry-only tests use synthetic data. Until a separately reviewed adapter exists, human tracing takes place in a governed study tool, not the unmounted application.
3. No real images, DICOM, thumbnails, patient identifiers, or case-level exports enter GitHub, CI artifacts, cloud agents or public reports. A clinical data custodian must authorize study access and storage, strip metadata and burned-in identifiers, review residual facial-image reidentification risk, restrict access, and define retention and applicable consent/ethics review. Do not acquire extra radiographs solely for this software test.
4. Use random study codes; keep the reidentification key separately under custodian control. The developer receives synthetic fixtures or approved aggregate results only. Remove sensitive fields from screenshots, logs and failure artifacts.

## Practical blinded design

- Pilot proposal: 30 independently selected eligible existing lateral images, two qualified examiners, three separate sessions. This yields 180 traces, NOT 180 independent patients. Thirty is an operational pilot size, not a powered validation sample. A statistician uses pilot variance and desired confidence-interval precision to plan the independent confirmatory sample.
- Prespecify inclusion, exclusion and sampling strata: relevant age bands, dentition, skeletal patterns, image quality, devices/acquisition settings, and intended local population. Keep difficult-but-eligible images; record unreadable landmarks rather than silently excluding them. Do not infer ancestry from imagery.
- Train on a distinct set. Freeze instructions before evaluation. Independent examiners cannot see each other's marks, previous traces, derived results, diagnoses or time-point labels. A coordinator randomizes image codes/order anew each session and holds the linking key. Use at least one week washout as a provisional design choice; document memory risk and deviations.
- In the primary tracing study, reuse the same independently verified image calibration and coordinate frame. Separately study full-workflow repeatability with calibration repeated independently. Do not mix the two error sources without labeling them. No change to display transforms or algorithm between sessions.
- Lock each trace before advancing. Preserve all revisions and reasons; do not overwrite a poor trace after seeing disagreement. Record missing/not-identifiable status, confidence category, technical problems and duration. Analyze all eligible images with transparent denominators.
- Adjudication occurs only after the blinded study is locked, on a separate reference stream. It cannot retroactively replace independent results. Any algorithm assistance requires a distinct randomized comparison against manual tracing and disclosure of assistance.

## Analysis plan, fixed before unblinding

For every landmark, report original-coordinate x/y mapped through verified calibration to mm, signed paired displacement on each axis, axis bias, variability and radial disagreement distribution. Report median and 95th percentile radial disagreement with uncertainty, availability rate and reasons for missingness. Do not call pairwise disagreement absolute anatomical error. Record directional anisotropy; a single pooled radial mean can hide a poor vertical component.

For each derived measurement, recompute from every complete independent trace using the frozen engine. Report units, examiner/session, usable patient count, missing count, signed paired mean difference (bias), SD of differences, and agreement limits with confidence intervals. Show difference-versus-mean plots and assess heteroscedasticity/outliers. Do not delete outliers simply to improve agreement.

For one prespecified independent pair of repeats per patient under approximately normal, constant-variance differences, descriptive 95% limits are mean difference +/- 1.96 times SD of differences. The random repeatability component is 1.96 times SD of differences, equivalently 1.96 times sqrt(2) times within-examiner SD under independent equal-variance repeat errors. These approximations are not clinical acceptance thresholds or proof of treatment change. Bias must be reported separately.

With three sessions, multiple examiners, multiple images per patient or repeated visits, do not treat all pairwise differences as independent. Use an explicitly specified crossed/multilevel variance model and patient-clustered uncertainty, reviewed by a statistician. Bootstrap by patient, retaining its traces together, if an appropriate bootstrap is used. Small samples require cautious confidence intervals. Record model assumptions, software and seed.

Report intraexaminer results separately for each examiner, then interexaminer agreement. ICC is supplementary: specify absolute agreement, single versus averaged measurements, fixed versus random examiner scope and confidence interval. Do not report an unlabeled ICC or use correlation alone as acceptance. Joint landmark error/covariance matters: do not propagate independent point-error assumptions into derived-measure uncertainty without checking them. Recomputing measurements from complete paired traces preserves their dependence.

## Decision and reporting gates

Before unblinding, the scientific reviewer defines a separate acceptable bias and disagreement envelope for each intended measurement/use, supported by evidence, and the required precision of estimates. Unknown tolerances remain unresolved, not automatic passes. Report pass / fail / inconclusive per measurement; a pooled average cannot rescue a failing landmark or metric. Separate technical geometry acceptance from human-study acceptance.

No universal 1 mm, 2 mm or 2 degree rule is introduced. Published population norms, repeatability, smallest detectable change and clinically important change are different concepts. Neither a high ICC nor a printed decimal proves that an individual treatment delta is meaningful. Do not issue automated extraction, expansion or other treatment recommendations.

Results are limited to the examined population, examiners, modality, quality range, calibration process and build. Same-image retracing omits acquisition/repositioning error; it cannot alone validate longitudinal change across independently acquired radiographs. Normative classifications require a separate population-appropriate evidence review.

## Deliverables before any clinical-readiness claim

- Signed protocol and scientific definitions; privacy/custodian approval; blinded allocation ledger retained privately.
- Per-landmark and per-measurement aggregate results, confidence intervals, missingness and limitations; independent statistical/scientific review.
- Restricted trace manifest: study code, examiner code, session, protocol/build/definition versions, calibration ID, image transform, point validity, measurement validity and audit revision. No names, record numbers or original filenames in developer exports.
- Public developer artifact contains only synthetic examples, methodology and approved aggregate tables. No source images or case coordinates.
- Repeat study for material definition, acquisition, calibration, UI or algorithm changes. No deployment is implied by this document.

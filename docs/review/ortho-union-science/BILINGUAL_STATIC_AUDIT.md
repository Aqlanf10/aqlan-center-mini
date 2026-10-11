# Ortho/Ceph bilingual static audit

Prepared: 2026-10-11 22:42 UTC. Repository: Aqlanf10/aqlan-center-mini.

Purpose: guide the existing implementation owner composing PR324 component baseline 476f374b33e996bcf2909cbdb9449d25fffcc6c0 with PR325 2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9. This review does not start another implementation stream.

## Result and limits

Bilingual support is incomplete in the inspected source. The strongest confirmed gaps are Arabic-only assessment/retention/image-editor interfaces, raw internal codes in results, and no evidenced end-to-end language selection for saved-study export.

Static inspection only. No implementation edits, application/test/build execution, browser use, remote refresh, or live-Production claims. Acceptance tests below are proposed, not executed. Historical renderer source does not establish an activated renderer or generated artifact.

The owner's requirements include full Arabic/English interface, results, PDF and editable PPTX. Preserve authored clinical text and scientific/landmark abbreviations. The supplied implementation prompt independently requires central translation, appropriate measurement/formula direction, no automatic replacement of original clinical notes, and native RTL/LTR validation in both PowerPoint and LibreOffice (prompt lines 91, 325–328 and O23 at407).

## Source boundaries and exact identities

Path aliases used in every finding:

- S = /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay
- C = /workspace/shared/recovery-20261011-0105/publisher/source/OrthoFirstFinalFiles
- R = /workspace/shared/recovery-20261011-0105/renderer/review-bundle-08/overlay
- H = /workspace/scratch/cf319c8268ad/ortho-owner-handoff-2158/package

The historical236 overlay is a selected source overlay, not a complete repository. Its winning MANIFEST.json is recorded as SHA256 88c3b822460b99bb71c386c25d09f0315f5a1231a305d38bf6bc4f5715a857e9. The recovered archive is recorded as SHA256 c90c7041b3eafd01afbbfffda9840e2520cb976317d791d89de31e62a9c5dd1d. H/provenance/CURRENT_SOURCE_PINS.json records the PR324/325 heads observed at22:00:25Z. Those are saved provenance, not a new remote observation by this review.

PR324 source inclusion and changed/unchanged status come from H/provenance/PR324_SOURCE_SELECTION.json. Local SHA256 was checked against currentSha256 for the unchanged modules cited in the confirmed findings: assessment, findings, measurements, intake, journey navigation, retention editor/events/document picker, image editor, clinical-field definitions, study schema and template registry. Exact hashes are appended below and retained separately in SOURCE_SHA256SUMS.txt.

Important exclusions: OrthoCaseStudy and OrthoSavedStudyReview changed between archive236 and PR324. PatientOrtho and PatientCeph were excluded from the independent PR324 selection. Findings about those files below are archive integration checks, not findings against the current composed branch. C and R are historical source snapshots; their current branch equivalence is not established here.

## Confirmed PR324-selected gaps

### B1. Assessment forms lack locale-aware copy and direction

- S/components/OrthoAssessmentFindingsV2.tsx:9–14,23–85: Arabic state labels, headings, accessible names, helper text, confirmations and notices; fixed dir="rtl"; no locale prop.
- S/components/OrthoAssessmentMeasurementsV2.tsx:12–15,69–121: same issue across measurement entry, decimal controls, source metadata and validation.
- S/components/OrthoCaseAssessmentV2.tsx:19–22,96–124,125–173: Arabic-only save/recovery/conflict/discard states and fixed RTL. The wrapper passes no locale to its children at154–161.

Acceptance: render all four assessment sections in English and Arabic, including empty, loading, read-only, restricted, conflict, malformed-draft and uncertain-save states. Labels, accessible names, dialogs and notices must match the active locale. Locale switching must not destroy or submit drafts.

### B2. Result and historical displays leak internal identifiers

- S/components/OrthoAssessmentMeasurementsV2.tsx:121–134 directly displays error codes, selection.method, selection.arch, unavailable reason and reference verification/review enums. Examples include arch_space and upper.
- S/components/OrthoCaseAssessmentV2.tsx:26–28,142–144 recursively displays raw object-key paths, source kind and source state.
- Its save handler forwards raw server message at109–111 without a localized error-code mapping.

Acceptance: trigger each supported incomplete/unavailable/unsupported/invalid result. Display translated explanation and field names; retain diagnostic codes only in an explicitly labeled technical detail if useful. Numeric value, sign, unit, method identifier and provenance must not change between locales. An unknown error code receives a safe translated fallback, not an empty message.

### B3. Clinical-field dictionary mixes presentation text with persisted clinical data

- S/lib/ortho-assessment-findings-v2.ts:3–27 contains Arabic-only field names and suggested answers.
- At29–36 the Arabic field title becomes observation.label.
- S/components/OrthoAssessmentFindingsV2.tsx:39–42 writes datalist selection directly as free text.

Implementation caution: translating UI dictionaries must not rewrite previously authored observations, historical Arabic choices, labels included in immutable witnesses, or their hashes. Do not retrofit a locale-dependent value into persisted clinical identity. Translate system headings from stable field identities while keeping historical stored text unchanged.

Acceptance: save mixed Arabic/English notes, switch locale, reopen and export. Original clinical text and revision/witness hashes remain unchanged. System field headings translate via stable field identity; historical authored text remains verbatim. Newly chosen translated suggestions must be clearly treated as newly authored input, not automatic conversion of an old record.

### B4. Intake, retention and image editing remain Arabic-only

- S/components/OrthoAssessmentIntake.tsx:41,62–75,84–109: notices, controls and fixed RTL.
- S/lib/ortho-assessment-intake-editor.ts:25–51: validation returns Arabic prose rather than a stable code plus localized presentation. This file is a supplementary source citation; verify its exact branch byte identity during composition.
- S/components/OrthoRetentionEventEditor.tsx:24–87: fixed RTL, event/device/arch/date/finding/status controls and accessible names.
- S/components/OrthoRetentionEvents.tsx:17–29,53–60,84–90,123: history labels, follow-up wording, validation and save outcomes.
- S/components/OrthoRetentionDocumentPicker.tsx:137–154: fixed RTL and Arabic picker/accessibility copy.
- S/components/OrthoStudyImageEditor.tsx:55–67,75–98,136–139: crop/rotation validation, controls, image alt text and preview outcomes.

Acceptance: repeat event creation, correction, replacement, historical review, restricted-document selection, invalid crop and unavailable preview in both languages. Keep physical device IDs, source IDs, dates and stored notes identical. Distinguish not measured, unknown, not applicable, unavailable and restricted in each locale rather than collapsing them into a common missing state.

## Existing bilingual support to preserve

- S/components/OrthoCaseJourneyNavigation.tsx:35–45,84 supports locale and RTL/LTR.
- S/lib/ortho-case-journey-navigation.ts:60–78 supplies English headings, steps and statuses.
- S/lib/ortho-case-template.ts:7,25–93 supplies titleAr/titleEn for the layout registry.

These are useful foundations. Translating only navigation does not cover child forms. Centralized copy should include visible strings, aria-label, title, alt text, placeholders, validation, loading/error/empty states, confirmation dialogs, result status and export status. Preserve existing locale-independent test IDs and domain identifiers.

## Archive integration checks requiring current-owner reconciliation

### B5. Locale is not wired through the archived parent

- S/components/PatientOrtho.tsx:871–878 mounts journey navigation without locale; its default is Arabic.
- Arabic parent error and arrival-summary copy remains at876 and883–893.

Acceptance: switch the application language from the actual patient page, not an isolated navigation fixture. All five sections and nested panels must update together without losing drafts, changing case scope, or issuing clinical writes. Test mobile and desktop navigation, keyboard focus order, back/forward and pending-save transitions.

### B6. Saved-study language/export flow is not evidenced

- Unchanged S/lib/ortho-case-study.ts:16–20,49–50 has no language field in StudyDraftContent.
- Archived S/components/OrthoCaseStudy.tsx:130,149–159 hard-codes RTL/titleAr and exposes no language selector;175 explicitly says export is disabled.
- Archived S/components/OrthoSavedStudyReview.tsx:16 selects titleAr.
- Language does exist in the separate render projection: S/lib/ortho-case-render-contract.ts:29,58–59.

Precision: the existing language field is in CaseProjection, not the saved study editor schema. Export language can appropriately be separate presentation configuration; the missing evidence is an explicit, reproducible path from UI selection to saved export specification, not proof that clinical revision schemas must be altered.

Acceptance: choose Arabic or English, reload/reopen export settings, generate PPTX and PDF from the same captured clinical snapshot, and verify artifact metadata/specification records the choice. Changing output language must not mutate clinical revisions. Format errors, converter unavailability and permission denial must be localized and must not prevent independent draft save.

### B7. Ceph has partial bilingual data but Arabic-only consumers

Historical C/components/CephTracer.tsx:
- 1055–1082 selects interpretationAr for summary cards.
- 1548–1586 selects landmark .ar and single-language hint.
- 1676–1689 selects school.descAr/nameAr.
- 1712 selects r.ar for charts.
- 1746–1747 and1823–1825 show both interpretation languages together rather than selecting interface language.

Historical C/lib/ceph.ts:
- 108–113 has ar/en landmark names but only one hint.
- 231–236 has nameAr/nameEn but only descAr.
- 891–913 creates Arabic-only reference-reading labels.

Archived S/components/PatientCeph.tsx:382–385,402–437,453 contains Arabic notices, headings/actions and explicit labelAr stage display.

Acceptance: cover landmark tooltips/instructions, calibration errors, stages, school names/descriptions, measurement charts/tables, references and comparison results in both languages. Preserve S, N, ANB, WITS, U1–NA, FMA, FDI numbering and scientific author/method names. Localizing descriptions must not modify formulas, reference values, clinical claims, approval state or unknown-value behavior. This is display work only; no future AI/Dot feature is included.

## PDF/PPTX evidence gap

R/lib/ortho-case-presentation-render.ts switches headings, status copy, continuation markers, alignment and RTL from projection.language at39–59,85–106,222–252. However:
- Text wrapping at14–24 explicitly describes a conservative estimate, not native glyph-fit proof.
- All text elements inherit one document-level direction at40–44. Mixed-direction clinical text and numerical expressions need native review; this static fact alone is not proof of a visible rendering defect.
- R/__tests__/fixtures/ortho-case-template-synthetic.ts:30–55 fixes language to Arabic and supplies Arabic system-like table headers/content.
- The inspected template/PDF tests contain no English-language branch exercise. The mixed-RTL preservation test is not a substitute for opening both formats.

Required acceptance: generate the same long synthetic case in ar/en, including long tables, Arabic notes in English output, English notes in Arabic output, negative values, decimals, ±, %, mm, °, wire dimensions and landmark abbreviations. Inspect editable PPTX text/tables and actual PDF pages; open PPTX in PowerPoint and LibreOffice. Check shaping, bidi ordering, minus signs, headers, continuation pages, clipping, overlap, missing glyphs and image geometry. Preserve authored text verbatim. No bilingual-export completion claim is warranted until that evidence exists.

## Suggested implementation order for the existing owner

1. Reconcile these findings against the current composed source; respect existing ownership of shared files.
2. Establish one locale source and central display dictionary, preserving domain values, identities and immutable clinical content.
3. Wire parent-to-child locale/direction; translate assessment, intake, retention and media editor states and accessibility strings.
4. Replace raw display enums/error codes with localized presentation mappings and safe fallbacks.
5. Extend Ceph display dictionaries and consumers without altering scientific calculations, reference content or clinical authority.
6. Complete an explicit export-language selection/configuration path and bind it to captured export metadata.
7. Run actual mounted bilingual journeys plus native two-language PPTX/PDF acceptance on the final composed head. Do not promote static source review to runtime or Production acceptance.

## Source fingerprints

The following SHA256 values fingerprint the exact source files read for this report. Absolute paths identify the reviewed snapshot, not a promise of cross-executor accessibility. The saved primary task should materialize this report through its confirmed Library identity and reconcile paths against its own checkout.


```text
7e97ceaa55625bc0dc8ba3f122b4e758d0c69cbaafef0698b44df33224f2bcd7  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoAssessmentFindingsV2.tsx
db98ba9789b676c31f52e59929e8268a0b2163511fda591e22d52a11cec4c38f  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoAssessmentMeasurementsV2.tsx
009c9b791551852c0228c26fae4593a2ac1eac6aaccb5e7799c009bda068bbe7  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoCaseAssessmentV2.tsx
5cf03d2029c51bde32b597ab5bba1f7730c6cd2ede9b9c5bab0557b9dfe699b1  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoAssessmentIntake.tsx
fc57e4cf12e05d98e0595563c144c9ffb8cdd3b241ecfbe309436b13cbacc6ae  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoRetentionEventEditor.tsx
5843c0e4152bcbdc466ad8ad50a378c2806d15af3c2bc67cf9748de1b7235c1d  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoRetentionEvents.tsx
b4479bd67faedf1faaf0ccd9b28dfed0ae2dacdfd4edc89a332bafb712b0daf9  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoRetentionDocumentPicker.tsx
6971661d0e4f443ac258d816673ed6c91d6bac6099fdae3609b3a4eac10755a5  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoStudyImageEditor.tsx
5efa2854df4653842c5dc7971f0ec9174375c623677cdfe2a9d551e82f2d55dd  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoCaseJourneyNavigation.tsx
2f0c34b10f0c90b7444f9953cd8688996f74d1bc694846b052721ff3203b99fe  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoCaseStudy.tsx
a8023ea3182e00bb7405b6c5858335ebd0e89afb4200c016e4a3fc7a3742fcf9  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/OrthoSavedStudyReview.tsx
5922f17fdc60615074532d4dd9e3333241395d64eb0d8cfcffc1fcdf6b5d6593  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/PatientOrtho.tsx
be9258afa315f13a99adcd86592b383620f4583073ef2a9a1fd043d91eb2282a  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/components/PatientCeph.tsx
1d9f7e52665c230f3a17e5398197097b32873b80a3141a21df76da763dd9dbf0  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/lib/ortho-assessment-findings-v2.ts
8c6e262d9eea37c5a315b903d23af7f9043bcaf44b1ebebeafa66b115b45b785  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/lib/ortho-assessment-intake-editor.ts
f7081f866ef8b3b0f3c50184536de068fa27ae97879a4f8b4e247bd7bd8dd137  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/lib/ortho-case-journey-navigation.ts
c5bef0dad37cd653f245e165f9f5e1a0cf411e1b11c767558c90cf79d0cd5a8a  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/lib/ortho-case-template.ts
fca34fd4fbebc755d98d2a0baf828070ba6deca0a48d93f42a94891163d80b05  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/lib/ortho-case-study.ts
64b218be4f80513a16e57cfb4b1cb586311fce2a2c80663d923d62b253715b8f  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/lib/ortho-case-render-contract.ts
49c882089c5c0816a8c9b2c80f96048244571e652d064159f3e3cf59705a5afb  /workspace/shared/recovery-20261011-0105/publisher/source/OrthoFirstFinalFiles/components/CephTracer.tsx
7c9c592f7e698a33099efbb603f94c490df08d2eebfab5b673ad4cee8a83fa07  /workspace/shared/recovery-20261011-0105/publisher/source/OrthoFirstFinalFiles/lib/ceph.ts
d756e5e2616709649e2d7ad762e1d9f4ba90e21a6ec4d17711e3f0d3df966112  /workspace/shared/recovery-20261011-0105/renderer/review-bundle-08/overlay/lib/ortho-case-presentation-render.ts
d4cd1389cae896de3a43b32ced96bd6b3dbe18711a5758cc205f129037b3e3b0  /workspace/shared/recovery-20261011-0105/renderer/review-bundle-08/overlay/__tests__/fixtures/ortho-case-template-synthetic.ts
63a765be071d9be32d88fb9b18d0ea4d5b6d0636eb8eed91df21c93510e1af2f  /workspace/shared/recovery-20261011-0105/renderer/review-bundle-08/overlay/__tests__/ortho-case-template-render.isolated.ts
e9f1405a25575c053e483aecdfbb72e87bd63b26f13482084d78e1b7107cb950  /workspace/shared/recovery-20261011-0105/renderer/review-bundle-08/overlay/__tests__/ortho-case-pdf-worker.isolated.ts
5f0f83ec494098f059b61142766f07e55a8e42c2a7f57aca1b9b5aa0005ae6ac  /workspace/scratch/cf319c8268ad/ortho-owner-handoff-2158/package/provenance/PR324_SOURCE_SELECTION.json
bcec07fe40ebf57237d78becbfd94ceb65d5848c058db72282f6a7fb775d2f59  /workspace/scratch/cf319c8268ad/ortho-owner-handoff-2158/package/provenance/CURRENT_SOURCE_PINS.json
88c3b822460b99bb71c386c25d09f0315f5a1231a305d38bf6bc4f5715a857e9  /workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/MANIFEST.json
94fa7a895ce0b0079fcc1475967e61ff92bd182e634b6c347fe8b67e08332c9e  /workspace/shared/recovery-20261011-0105/publisher/stores/OrthoFirstFinalManifest.json
10f53d8230f857215d8e82fe46b9eb3d5fac392f41a325216bd18f866b4d2f29  /workspace/shared/recovery-20261011-0105/renderer/review-bundle-08/MANIFEST.json
9f4487464fe808ae046956158693f357b6452097604cd969af6caeb02b4f6d73  /workspace/scratch/cf319c8268ad/ortho-owner-handoff-2158/references/Aqlan-Ortho-Ceph-Implementation-Prompt-2026-10-11(1).md

```

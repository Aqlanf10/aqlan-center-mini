# Pont: lecture-to-primary-source review, 2026-11-10

Read-only review of product HEAD a2efe399a257bf9e003ba8fa5637f205ab21a933. No formula enabled, code edited, database accessed or tests run. This is scientific implementation evidence, not clinical acceptance.

## Actual private lecture inspection

Opened the original PPTX XML in `/workspace/ortho-intake/cast-space-direct-attachments/`: CAST MODEL ANALYSIS has 78 slides; Methods of space creation and closure has 56. Visually reviewed CAST contact sheets covering slides 19–30, including the eight Pont slides 22–29, and Methods slide 16. Also searched the original slide text for expansion methods. This is not a claim to have visually reviewed all 134 slides. No slide images or patient material are included here or copied to the repository.

CAST 25–27 specify maximum mesiodistal widths of four permanent upper incisors, measured premolar width between distal pits of upper first premolars, measured molar width between mesial pits of upper first molars; predicted widths are SI*100/80 and SI*100/64 in mm. Slides 24/28/29 go further into expansion indication and 1–2 mm overexpansion. Those treatment assertions must not become automatic decisions. Methods 16 distinguishes skeletal from dentoalveolar expansion; it does not establish that a Pont transverse difference equals arch-perimeter space gain. Ashley Howe and Linder-Harth were seen adjacent to Pont but were not independently validated in this review.

## Primary research checked

1. [Awath et al., 2025, full publisher text](https://ujpronline.com/index.php/journal/article/download/1267/1829?inline=1): 100 Sana’a dental students, ages 18–25, normal occlusion, permanent dentition. Its distal-premolar/mesial-molar landmarks and 80/64 formula match the lecture. It reports overprediction averaging about 2.19/2.03 mm. This is geographically relevant observational evidence against treating Pont as a universal target, not proof about every Yemeni patient. Proposed replacement coefficients 86/67 are derived from that cohort; the paper itself requests further validation. Do not substitute them as validated local norms. Limitations include narrow sampling, no treatment-outcome validation, and reporting/citation issues (e.g. impossible `p<0.000`, discussion citation 5 maps to an unrelated absent-incisor article). This source supports caution, not automatic therapeutic thresholds.

2. [Zahw et al., 2024, full primary article](https://link.springer.com/article/10.1186/s12903-024-04715-7): 184 Egyptian participants aged 19–24; four occlusal groups. Same 80/64 arithmetic, but its molar measurement uses **central fossae**, unlike the lecture/Yemeni study's **mesial pits**. It reports poor predicted-versus-measured agreement (ICC<0.5). Preserve protocol-specific landmarks; do not pool generic “intermolar width” across those definitions. This study does not validate a Yemen-specific decision rule.

Original Pont 1909 was not accessed. Historical attribution is secondary within these primary validation papers. The 1995 Angle Orthodontist publisher full text returned 403, and the Bangladeshi PDF timed out; neither is claimed as fully read. Primary research is stronger than an unreferenced teaching assertion but does not by itself establish treatment safety or external validity.

## Existing product and safe next boundary

- `lib/ortho-assessment-measurement-set-v2.ts:6` explicitly disables Pont. Its measurement-set contract (lines 3–4) references tooth widths and available arch space, not Pont transverse endpoints.
- `lib/ortho-assessment-v2.ts:14` has no typed interpremolar/intermolar landmark definition. Free clinical text is not a substitute for a numeric protocol-bound input.
- Safe next implementation would first add an explicit, versioned transverse-measurement protocol and source-linked observations, reusing existing 12/11/21/22 tooth-width observations rather than re-entering them. Require the selected upper first-premolar/first-molar endpoint definitions, mm, acquisition method, source revision, date/status and documented operator. Uncalibrated photo pixels cannot become mm.
- Keep Pont disabled for now. Before enabling an optional historical reference calculation, show measured width, calculated reference and signed difference separately; never label the difference “required expansion” or “space gained,” diagnose narrow/normal automatically, add 1–2 mm, or populate a treatment/space budget automatically. Doctor interpretation remains distinct.
- Before such activation: tests for missing/nonpositive inputs, wrong teeth/arch, absent teeth, incompatible landmark protocols, uncalibrated image sources, source version conflicts, exact historical replay and no automatic diagnosis/space-ledger mutation. Clinical review of the wording/protocol remains required. No claim that present code/tests implement these proposed safeguards.

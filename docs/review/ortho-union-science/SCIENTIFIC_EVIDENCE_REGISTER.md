# Ortho/Ceph scientific evidence register

Review date: 11 October 2026. Intended use: implementation specification and independent verification for Aqlanf10/aqlan-center-mini.

## Decision summary

The calculation layer can be grounded in original articles, with explicit measurement protocols and versioned references. A citation does not itself establish population applicability, clinical validity, or approval of a treatment decision. Keep these separate:

1. Measured input and its acquisition/calibration provenance.
2. Deterministic arithmetic and formula version.
3. Reference sample, statistical quantity and applicability.
4. Clinician interpretation and signed approval.

The strongest directly inspected foundations here are Bolton's 1962 ratios, Tanaka–Johnston's 1974 prediction definitions, Jacobson's original Wits geometry, and the DICOM calibration specification. Yemen-specific evidence was found, but it does not justify a universal Yemeni mixed-dentition default. One local prediction article contains material internal inconsistencies.

This is a focused evidence review, not a systematic review or clinical approval. No app, tests, build, SQL, patient records or Production were executed or changed. Synthetic verification cases are in `SYNTHETIC_CALCULATION_FIXTURES.md`. Historical source findings are separately scoped in `STATIC_SOURCE_REVIEW.md`.

## Access and evidence labels

- **Full text inspected:** actual article text was available and the relevant methods/results were read. Where only selected pages were reviewed, those pages are named.
- **Abstract inspected:** claims are restricted to the authors' abstract; unviewed tables, detailed protocols and norms are not verified.
- **Catalog only:** official publisher metadata establishes the reference's identity, not the contents of a chapter.
- **Evidence type:** describes what the source can establish. It is not a formal GRADE assessment.

## Original and primary research

### E01. Bolton tooth-size ratios

Bolton WA. The clinical application of a tooth-size analysis. American Journal of Orthodontics. 1962;48(7):504–529. [Publisher record](https://www.sciencedirect.com/science/article/abs/pii/000294166290129X); [DOI](https://doi.org/10.1016/0002-9416(62)90129-X); [original article hosted by the Brazilian Board of Orthodontics](https://bbo.org.br/bbo/files/bibliografia/artigos/55_The%20_linical_application_tooth_size_analysis.pdf).

**Access:** original full text obtained; pp. 506–508 and 517 visually checked against extraction. **Type:** historical derivation and clinical-method report.

- Page 507: overall ratio = 100 × summed mandibular widths / summed maxillary widths, using 12 teeth per arch, first permanent molar through first permanent molar. Anterior ratio uses six teeth per arch, canine through canine.
- Page 506: 55 selected excellent occlusions, 44 treated without extraction and 11 untreated. This is not a population-wide diagnostic sample.
- Page 508: original sample means are 91.3% overall and 77.2% anterior; sample SDs are 1.91 and 1.65 percentage points respectively. SD, SEM and observed range are different quantities.
- Page 517 supports reference-dependent residual widths. With U and L in mm and reference fraction r: L − rU and U − L/r are distinct counterfactual residuals. They do not prescribe tooth reduction, addition, extraction or another intervention.

**Implementation:** exact tooth identity sets; positive measured widths; no missing-tooth zero substitution; explicit numerator/denominator and reference version. These historical means may be displayed only with their provenance and applicability status, not as universal treatment targets.

### E02. Tanaka–Johnston mixed-dentition prediction

Tanaka MM, Johnston LE. The prediction of the size of unerupted canines and premolars in a contemporary orthodontic population. JADA. 1974;88:798–801. [Repository record](https://uwcscholar.uwc.ac.za/items/5a980970-d331-4010-9ba7-406298680a7c); [original article](https://uwcscholar.uwc.ac.za/bitstreams/f992423a-c0f1-44d8-86d1-128545c59ccd/download); [DOI](https://doi.org/10.14219/jada.archive.1974.0158).

**Access:** four-page full text inspected. **Type:** regression derivation, not external validation in the current clinic.

- Page 799: X is the total mesiodistal width of all four permanent lower incisors. Y is one canine-plus-two-premolar segment; units are mm.
- Pages 800–801: convenient approximate 75th-percentile rules are upper quadrant X/2 + 11.0 and lower quadrant X/2 + 10.5.
- Page 799 regression means are different: upper 10.41 + 0.51X; lower 9.18 + 0.54X. Do not interchange mean prediction and percentile approximation.
- Page 798: 506 Cleveland-area pretreatment patients, under 20, of probable European ancestry, with erupted intact measured teeth.
- Page 799 limits the published percentile tables to X = 20.5–27.0 mm to avoid extrapolation. This is a table-support boundary, not a universal physiological range.

**Implementation:** persist prediction method, quadrant, dentition, units and applicability review. The output is predicted tooth width, not measured arch space or certainty about an individual. Use separately measured upper incisors when constructing an upper-arch total.

### E03. Wits geometry and the limitations of ANB alone

Jacobson A. The “Wits” appraisal of jaw disharmony. American Journal of Orthodontics. 1975;67(2):125–138. [PubMed abstract/DOI](https://pubmed.ncbi.nlm.nih.gov/1054214/); [original article copy](https://bbo.org.br/bbo/files/bibliografia/artigos/52_The_Wits_appraisal_of_jaw_disharmony.pdf).

**Access:** abstract and original scanned pages 127–134 inspected, especially pp. 129, 131–132. **Type:** original method and illustrative cases. DOI: 10.1016/0002-9416(75)90065-2.

- Page 129: project A and B perpendicularly to a specified occlusal plane through the region of maximum cuspal interdigitation; projections are AO and BO.
- Pages 131–132: positive when AO is anterior to BO; negative when BO is anterior to AO. Coincident projections are a valid 0 mm result.
- Figures on pp. 127–130 illustrate changes in ANB caused by cranial-base/jaw geometry; a single angle is not a standalone diagnosis.

**Implementation:** declare the exact occlusal-plane construction and an anatomical anterior direction. Compute the signed difference along that plane, with physical calibration. A zero result must remain distinct from a degenerate plane or missing landmarks. Do not normalize an AO–BO vector to obtain the measurement direction: that vector vanishes at a valid zero.

### E04. Wits plane variants are not interchangeable labels

Thayer TA. Effects of functional versus bisected occlusal planes on the Wits appraisal. AJODO. 1990;97(5):422–426. [Primary-study abstract](https://pubmed.ncbi.nlm.nih.gov/2333856/). DOI: 10.1016/0889-5406(90)70114-R.

**Access:** abstract inspected. **Type:** comparative observational study, 35 males aged 11–24 with Class II division 1 malocclusion. The two plane variants showed different associations with dental and skeletal measures. This supports an explicit plane identifier and prevents silent comparison of different protocols; it does not select a universally superior plane or norm.

### E05. Tweed triangle: geometry versus historical targets

Tweed CH. The Frankfort-Mandibular Incisor Angle (FMIA) in Orthodontic Diagnosis, Treatment Planning and Prognosis. Angle Orthodontist. 1954;24(3):121–169. [Original article hosted by the Tweed Foundation](https://tweedortho.com/wp-content/uploads/2024/12/frankfort-mandibular-incisor-angle.pdf).

**Access:** full scan available; pp. 121–124 inspected. **Type:** historical clinical-method report.

Page 124 describes the lower incisor axis through its apex and incisal edge intersecting the Frankfort and mandibular planes to form a triangle. Corresponding internal angles must sum to 180°. The original Frankfort construction used an ear-rod-based point; do not silently equate every historical construction to modern anatomical porion. Store the chosen landmark/plane protocol separately from historical reference values. No treatment thresholds from this historical report are endorsed here.

### E06. Measurement-specific software verification

Aksakallı S, Yılancı H, Görükmez E, Ramoğlu Sİ. Reliability Assessment of Orthodontic Apps for Cephalometrics. Turkish Journal of Orthodontics. 2016;29:98–102. [Publisher full text](https://turkjorthod.org/pdf/26a6643d-3380-4766-8ed8-4703e5d7d038/articles/TurkJOrthod.2016.1618/Turk%20J%20Orthod-29-98-En.pdf). DOI: 10.5152/TurkJOrthod.2016.1618.

**Access:** full text inspected. **Type:** small retrospective software comparison, 20 radiographs; not validation of AQLAN.

Page 99 records a calibration ruler and a measurement dictionary; pp. 100–101 discuss landmark, magnification and measurement-specific disagreement. An application sharing a familiar analysis name is therefore insufficient validation. Table 1 itself labels an anterior cranial-base distance with degrees: do not copy units blindly from a paper's table. SNA/SNB require their vertex at N, incisor measurements require the specified axis and surface/tip, and linear values require mm. Verify each convention against its original method, rather than importing the entire dictionary unchanged.

### E07. Arch-space measurement protocol

Leifert MF, Leifert MM, Efstratiadis SS, Cangialosi TJ. Comparison of space analysis evaluations with digital models and plaster dental casts. AJODO. 2009;136(1):16.e1–4; discussion 16. [Primary-study abstract](https://pubmed.ncbi.nlm.nih.gov/19577140/). DOI: 10.1016/j.ajodo.2008.11.019.

**Access:** abstract inspected. **Type:** method comparison in permanent Class I crowded dentitions, 25 paired model sets.

The study measured greatest mesiodistal tooth widths and arch length, using calipers and brass wire/ruler for plaster casts and a specified digital system for virtual models. It supports recording the acquisition method and validating the actual implementation; it does not validate arbitrary 2D photographs, every scanner, or a different arch-perimeter path.

**Implementation contract proposed:** available space and required widths must cover the same arch segment. For the existing ten-tooth permanent-arch contract, record the perimeter between the mesial boundaries of the first permanent molars and the matched ten teeth. Discrepancy = available − required, in mm: negative is a numerical shortage, positive is a numerical surplus. Endpoint/path selection requires clinical protocol approval; a curve, straight chord and segmented approximation cannot share an unspecified label.

### E08. Saudi validation of Tanaka–Johnston

Asiry MA et al. Is Tanaka-Johnston mixed dentition analysis an applicable method for a Saudi population? Saudi Medical Journal. 2014;35(9):988–992. [Primary-study abstract](https://pubmed.ncbi.nlm.nih.gov/25228181/).

**Access:** abstract inspected. **Type:** 409 model-pair observational comparison. The abstract reports overprediction and sex differences, with new locally derived regressions. This is evidence against assuming universal transferability; it is not evidence that a Saudi equation applies to a Yemeni patient. No new coefficients are imported from this abstract.

### E09. Moyers applicability and table identity

Al-Dlaigan YH et al. Validity of moyers mixed dentition analysis for Saudi population. Pakistan Journal of Medical Sciences. 2015;31(6):1399–1404. [Publisher record](https://www.pjms.org.pk/index.php/pjms/article/view/18459); [original full text at WHO EMRO](https://applications.emro.who.int/imemrf/Pak_J_Med_Sci/Pak_J_Med_Sci_2015_31_6_1399_1404.pdf). DOI: 10.12669/pjms.316.8377.

**Access:** full text inspected. **Type:** local cross-sectional derivation/comparison: 410 model pairs, ages 13–20, Riyadh clinics.

Pages 1399–1401 distinguish arch-space requirements and statistical predictions, and report differences from Moyers tables. The abstract's male mandibular slope is printed as 0.40, whereas Results states 0.49. This review does not resolve that discrepancy or activate a replacement equation.

**Implementation:** Moyers must identify the exact edition, table, arch, sex grouping where applicable, percentile, input interval and lookup/interpolation policy. An original Moyers table was not independently read here. Do not reconstruct it from a lecture slide, a regression mean, or another paper's table. Do not silently extrapolate, clamp to a table edge, or treat the 75th percentile as 75% individual diagnostic accuracy.

### E10. Yemen-specific Bolton pilot evidence

Al-Gunaid T, Yamaki M, Saito I. Mesiodistal tooth width and tooth size discrepancies of Yemeni Arabians: A pilot study. Journal of Orthodontic Science. 2012;1(2):40–45. [Primary-study PubMed record/abstract](https://pubmed.ncbi.nlm.nih.gov/24987624/). DOI: 10.4103/2278-0203.99760.

**Access:** indexed primary abstract inspected; direct full-text access presented a browser challenge. **Type:** observational pilot, 176 subjects aged 13–25, with several malocclusion classes.

The abstract reports no statistically significant difference between the sample's ratios and Bolton's. That result does not prove equivalence, validate all Yemeni ages/dentitions, or establish patient-level intervention thresholds. Useful as specifically Yemeni applicability context, not a universal local norm.

### E11. Yemen-specific mixed-dentition article: unresolved inconsistencies

Dahaq WAM et al. Tanaka and Johnston's mixed dentition validity: an analysis among Yemeni adults in Sana'a city. Universal Journal of Pharmaceutical Research. 2021;6(6):1–5; PDF records publication on 15 January 2022. [Publisher full text](https://ujpronline.com/index.php/journal/article/download/691/1089). DOI: 10.22270/ujpr.v6i6.691.

**Access:** full text read; pp. 3–4 visually checked. **Type:** local derivation/comparison, 227 adults aged 19–25, not prospective mixed-dentition child validation.

**Hold for clarification:** page 3 Results says overprediction; its Discussion and page 4 Conclusion say underprediction. Table 1 and Table 2 do not consistently reconcile with the stated equations: for example, the female lower-incisor mean 24.14 implies a lower Tanaka–Johnston prediction of 22.57 mm, but Table 2 prints 21.28 mm. Rounding cannot explain that difference. The authors call for further validation.

Do not implement the paper's new equations as an approved Yemeni default until an authoritative correction and independent validation resolve these issues. Do not substitute Saudi findings as a resolution.

### E12. Orthodontic measurement error

Houston WJB. The analysis of errors in orthodontic measurements. American Journal of Orthodontics. 1983;83(5):382–390. [Primary abstract](https://pubmed.ncbi.nlm.nih.gov/6573846/). DOI: 10.1016/0002-9416(83)90322-6.

**Access:** abstract inspected. **Type:** methodological paper. It distinguishes systematic bias from random error, emphasizes replication and cautions about individual and serial interpretation. This supports a retracing/repeatability protocol, not a universal numerical error allowance. The exact full-text error formulas were not verified here.

### E13. Agreement is not correlation

Bland JM, Altman DG. Statistical methods for assessing agreement between two methods of clinical measurement. Lancet. 1986;1(8476):307–310. [PubMed record](https://pubmed.ncbi.nlm.nih.gov/2868172/); [full-text author-style reproduction at McGill](https://jhanley.biostat.mcgill.ca/bios601/Surveys/ba.pdf).

**Access:** full reproduced text inspected; reproduction explicitly identifies corrections to original printing. **Type:** original measurement-agreement methodology.

Use paired differences and their distribution; correlation alone cannot establish agreement. For approximately normally distributed, appropriately independent differences with suitable constant spread, bias is their mean and approximate limits of agreement are mean difference ± 1.96 × sample SD. Predefine clinically acceptable differences per measurement with the clinical reviewer. Do not interpret the limits as a confidence interval for the mean, apply the basic formula to clustered repeated observations without an appropriate model, or claim adequacy from a tiny synthetic sample.

## Authoritative technical standard

### E14. Calibration and pixel spacing

[DICOM PS3.3, 2026d, section 10.7](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_10.7.html), official NEMA/DICOM publication. **Access:** complete section inspected. **Type:** normative imaging metadata standard, not a clinical outcome study.

Pixel Spacing is ordered row spacing then column spacing, in mm. Detector/scanner spacing and patient-calibrated spacing are not interchangeable. Geometry and fiducial calibration have depth/position assumptions; absent calibration metadata can leave correction status unknown.

**Implementation:** keep calibration source, marker size/endpoints, image identity, physical spacing and geometric assumptions. In anisotropic data, use physical coordinates before measuring distances or angles. A single mm-per-pixel factor is valid only for an isotropic metric after documented normalization. Uniform display zoom must not change physical results. A screenshot's DPI alone is not patient calibration. Unknown or invalid calibration produces unavailable physical distance, not zero. These safeguards are implementation deductions from the standard and elementary geometry.

## Global reference books and unresolved original-method checks

These are appropriate global clinical reference anchors; their unviewed chapters cannot be claimed as formula verification.

- **R01. Contemporary Orthodontics, 7th edition.** [Official Elsevier catalog](https://www.us.elsevierhealth.com/contemporary-orthodontics-9780323930710.html). ISBN 9780323930710; catalog lists Fields, Larson, Sarver and Proffit, publication 15 May 2025, copyright 2026. Catalog only. Obtain the licensed relevant diagnostic/space-analysis chapters and record exact pages before marking chapter-specific claims verified.
- **R02. Orthodontics: Current Principles and Techniques, 7th edition.** [Official Elsevier catalog](https://www.us.elsevierhealth.com/orthodontics-9780323778596.html). ISBN 9780323778596. Catalog only. Use for expert cross-checking of diagnosis, records and treatment-planning boundaries once the relevant text is actually inspected.
- **R03. Steiner CC. Cephalometrics for you and me. AJ Orthod. 1953;39:729–755.** [Publisher article target](https://www.sciencedirect.com/science/article/abs/pii/0002941653900827). DOI 10.1016/0002-9416(53)90082-7. Publisher full text unavailable in this review; do not claim that all Steiner norms/angle variants were independently checked.
- **R04. McNamara JA Jr. A method of cephalometric evaluation. AJ Orthod. 1984;86:449–469.** [Primary abstract](https://pubmed.ncbi.nlm.nih.gov/6594933/). DOI 10.1016/S0002-9416(84)90352-X. Abstract inspected; university-hosted full text could not be fetched. Age/sex-dependent length tables, landmark conventions and magnification basis remain unverified here. No universal Co–A or Co–Gn norm is authorized by this abstract.

## Acceptance contract for the implementation owner

1. Bind each active measurement to a source page/figure, exact landmarks/plane variant, directed or unsigned angle convention, unit, sign, scale dependence, and immutable formula version. Arabic/English labels must describe the same quantity.
2. Store references separately: source sample, age/dentition, sex grouping if used, recruitment/population, sample size, mean/SD/SEM/percentile identity, access state and clinical applicability decision. Never infer ethnicity from name or silently infer a reference group.
3. Preserve raw measurements and unrounded derived values; round at display/export boundaries. A changed source image, landmark, scale, formula or reference invalidates any derived approval until rereviewed. Historical approved results retain their original versions.
4. Run independent synthetic fixtures before clinical validation. Validate then with clinician-reviewed records, separate intra- and inter-observer repeats, blinded/randomized order where feasible, and per-measurement bias/agreement reporting. Decide acceptance limits before looking at outcomes. Passing software tests is not clinical validation.
5. Reject or explicitly mark missing/invalid inputs, duplicate tooth identities, degenerate lines, non-finite numbers, incompatible dentitions and unsupported reference applicability. Distinguish unavailable, measured zero, predicted value and unapproved result.
6. No automatic diagnosis, extraction, surgery, IPR amount or treatment plan follows from these calculations. Future AI/Dot capabilities are outside this review.

## Remaining evidence gaps

Exact licensed Moyers tables; complete Steiner, Downs, Ricketts, Jarabak, McNamara and Kim definition/reference audits; reconciled Yemen-specific prediction coefficients; and prospective, independently reviewed validation of this particular implementation remain open. The register must not turn those gaps into verified status because a lecture, software product, or another source mentions the method.

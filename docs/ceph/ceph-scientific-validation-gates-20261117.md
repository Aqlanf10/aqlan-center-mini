# Cephalometric scientific validation gates

Draft integration plan, 17 November 2026. No clinical validation claim, patient-data access, repository change or deployment is authorized by this document.

## Independent acceptance tracks

1. Engineering correctness: synthetic coordinates verify formulas, units, calibration transformations, orientation, degeneracies and regression stability. A pass proves only the specified computational behavior.
2. Intraexaminer repeatability: assess independently repeated landmark placement by each examiner using the blinded protocol below. Report each examiner separately.
3. Interexaminer agreement: assess independent landmark placement between qualified examiners. Do not replace independent observations with consensus before analysis.
4. Reference accuracy and clinical usefulness: require separately justified references, intended-use evidence and scientific review. Repeatability is not anatomical accuracy or evidence of clinical benefit.

## Required human-study protocol

The governing draft is `ceph-repeatability-protocol-20261117.md` in the same folder. It specifies a provisional 30-image, two-examiner, three-session pilot; training on separate images; randomized blinded sessions; a provisional one-week washout; frozen definitions/build/calibration; and privacy/custodian/ethics gates. The 180 traces are not 180 independent patients. A statistician must determine the confirmatory sample and analysis from the intended precision.

Keep landmark-level coordinate disagreement separate from each derived angular or linear measurement. Report signed bias, dispersion, uncertainty, missingness and measurement-specific agreement limits. ICC must be labeled and is supplementary, not the sole acceptance test. Repeated observations require patient-clustered or appropriate multilevel analysis. Separate fixed-calibration retracing from full-workflow repeatability and acquisition error.

## Release and evidence matrix

Each measurement requires its own record: definition/version; synthetic test evidence; intraexaminer evidence; interexaminer evidence; independently justified accuracy evidence; intended-use tolerance rationale; uncertainty; reviewer; and pass/fail/inconclusive decision. Unknown or unmeasured items remain unresolved. Engineering success must never mark the human-study columns as passed.

Before unblinding, a scientific reviewer must define evidence-backed acceptable bias and disagreement for the specific intended use. No general 1 mm, 2 mm or 2 degree threshold is adopted. High ICC, small p-values, consensus, or display precision do not establish clinical suitability. Normative classification and longitudinal treatment change require additional evidence.

## Evidence provenance and restrictions

Supporting primary abstracts: PMID 21055590 (Damstra et al.) and PMID 20451778 (Lagravere et al.). Only abstracts were available in the governing protocol; full methods, detailed tables and population distributions are not verified. Do not import unverified numerical cutoffs or generalize their samples.

No patient images, identifiers or case-level coordinates may enter developer artifacts, GitHub, CI or cloud agents under this plan. Study work starts only after separately authorized privacy/ethics and data-custodian arrangements. Developers receive synthetic fixtures or approved aggregate results. Material changes in definitions, calibration, acquisition, UI or algorithm trigger an impact assessment and appropriate repeat validation.

## Axis-specific landmark repeatability and error propagation (17 November 2026 addendum)

Primary source: Grogger et al., Identification of Point A as the prevalent source of error in cephalometric analysis of lateral radiographs, 2018; PMID 29650356; DOI 10.1016/j.ijom.2018.03.019. https://pubmed.ncbi.nlm.nih.gov/29650356/

Evidence scope: the verified abstract describes retrospective preoperative lateral images from dentofacial-deformity patients, three independent raters, and 1116 tracings. It reports predominant Point A x-coordinate error for SNA, ANB, Wits, APDI and ODI, and Nasion y-coordinate error for SNB. These are study-specific findings, not proof that A is always the least reliable point. The publisher's indexed methods excerpt describes exclusions from 491 initial patients; the full paper was inaccessible (403). Detailed acquisition, repeat-session design, axis convention, statistical models and acceptance limits have not been fully verified. Do not infer intraexaminer reliability from three independent raters alone, or treat 1116 tracings as 1116 independent patients.

The following is a proposed protocol extension, not a reproduced method from that paper and not a clinical acceptance decision.

1. Freeze image orientation, scale and coordinate convention. Declare x/y direction and units before analysis; image rows/columns must not silently stand for anatomical horizontal/vertical. Analyze fixed-image, fixed-calibration tracing separately from whole-workflow calibration/orientation variability. Do not align each trace using its own noisy landmarks in a way that removes the error being measured.
2. Keep independent, blinded coordinates for every landmark and examiner/session. For each landmark, report paired signed dx/dy, axis-specific bias and dispersion, covariance/error ellipse and radial disagreement. Compute intraexaminer and interexaminer results separately, with image/patient clustering. Radial distance alone hides directional bias. Agreement is not anatomical accuracy without an independent justified reference.
3. Prioritize A-x and N-y as prespecified hypotheses, but retain all measured axes and landmarks, including the occlusal-plane endpoints and ANS/PNS required by Wits/APDI/ODI. Report subgroup/image-quality failures rather than removing them after seeing results.
4. In a frozen local anatomical/reference frame, additionally resolve disagreement parallel/perpendicular to each relevant defining plane. Specify which trace supplies the plane or use an independently frozen reference. When plane landmarks themselves vary, separately propagate their uncertainty; perpendicular/parallel findings for one construction do not generalize to all measurements.
5. Recompute SNA, SNB, ANB, Wits, APDI and ODI from each complete independent trace with the same versioned, source-reviewed formulas. Report paired measurement bias, agreement limits with uncertainty, and missing/uncomputable rates in degrees or mm as appropriate. No assumed default angles may fill missing landmarks. Keep nonlinear/correlated whole-trace error distinct from one-coordinate sensitivity experiments.
6. Developer-only sensitivity fixtures: perturb each synthetic landmark separately along x and y and then jointly under declared correlated scenarios; recompute all affected measurements. Choose a documented grid for numerical characterization, not a claimed clinical tolerance. Check orientation/mirroring, Wits zero, degeneracies and formula-version equivalence. Finite-difference sensitivity and optional covariance propagation are engineering analyses, not clinical validation. Do not use patient-derived case coordinates in developer artifacts.
7. Before confirmatory data inspection/unblinding, freeze a threshold register for each landmark axis and each derived measurement: intended use, signed-bias bounds, acceptable disagreement limits, confidence level, missingness cap, any allowed classification-change rate, rationale/source, reviewer and version. Thresholds may differ by measurement or intended use. The scientific reviewer must supply the numeric values; absent justified values means NOT EVALUABLE, not PASS. Never choose limits after observing results or borrow universal 1 mm/2 mm/2 degree limits.
8. Prespecified decision rule: PASS only when the uncertainty bounds for the chosen agreement estimands satisfy all registered bounds, with missingness and predefined subgroups also acceptable. FAIL for a demonstrated breach; INCONCLUSIVE when uncertainty straddles a bound or sample precision is insufficient. Freeze the exact estimands and multiplicity approach with the statistician. A pilot may inform a later registered confirmatory design but is not its own post-hoc acceptance validation.

No human data were collected or analyzed for this addendum. Ethics/privacy and data-custodian authorization remain prerequisites for any real-image study. No clinical software behavior or reference thresholds are changed by this document.

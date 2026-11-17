# Independent cephalometric core, research slice 1

Status: **research / engineering only**. Clinical use is explicitly disabled in every result.
Baseline: `c6c886121bcc50aa548f64b0b0fbd7b5beb1f324`.
Engine: `steiner-core-8/0.1.0-research`.

## Scope and non-goals

This additive module implements reproducible 2D geometry and eight explicitly defined candidate Steiner measurements. It is NOT the complete Steiner analysis, a new clinical diagnosis engine, or a replacement for `lib/ceph.ts`. No app page, route, database, stored analysis, adjustment visit, wire selection, treatment plan, billing pathway, AI feature, or production configuration calls it. No patient images or records were used in its tests.

This slice contains independent code, synthetic fixtures and documentation. No Dolphin, OrisCeph or WebCeph executable, proprietary analysis XML, UI asset, image, norm table or source code is imported. Vendor manuals inform workflow questions, not scientific validity or permission to copy their assets.

## Coordinate and calibration contract

- Input coordinates are original image **column-right, row-down**, never display/canvas coordinates.
- Projection must be `lateral-2d`; PA, 3D and perspective reconstructions are not accepted.
- Anterior direction must be declared as left or right. It is not inferred from image metadata or guessed from points.
- Canonical mathematical coordinates are x anterior, y up. With right-facing images x = column × columnScale; with left-facing images x = -column × columnScale. y = -row × rowScale.
- Row and column scales are independent. DICOM spacing order is **row then column**, not x then y. Do not compute angles in distorted raw pixels.
- `patient-plane`: positive finite mm/row and mm/column, provenance string and explicit scope confirmation required. Only this kind permits patient linear distances. These caller assertions are NOT verification that a calibration marker is at the patient's anatomical plane.
- `detector-plane`: allows aspect-corrected research angles, not patient distances. A uniform geometric projection model does not correct differential anatomical depth or perspective distortion.
- `ratio-only`: proportional positive row/column scales; common scale is normalized away. It allows angles only. An unrepresentable aspect ratio is rejected.
- Image geometry and calibration revision must match. Resampling must update both coordinates and spacing, and increment the geometry revision. Mere matching numbers cannot prove external provenance.
- Display zoom, pan, rotation and overlays do not alter source geometry. No additional magnification factor is applied implicitly to calibrated coordinates.
- `isotropicScaleFromReference` computes known reference mm / measured pixels. It assumes isotropic pixels and does not establish marker depth.
- Magnification factors are multiplicative: 1.08 is 108% of true size. Explicit basis conversion is value × toFactor / fromFactor. Equal factors preserve the original number exactly. Unsupported numerical range is an error, not a false zero. The core does not apply this helper automatically.

DICOM's distinction between Pixel Spacing and Imager Pixel Spacing supports not silently treating detector dimensions as corrected patient dimensions: [Pixel Spacing](https://dicom.nema.org/medical/dicom/2026b/output/chtml/part03/sect_10.7.html), [DX detector attributes](https://dicom.nema.org/medical/Dicom/current/output/chtml/part03/sect_C.8.11.4.html).

## Landmark dictionary and outstanding review

Identifiers are deliberately separate from the legacy landmark codes:

| ID | Candidate anatomical reference | Review limit |
| --- | --- | --- |
| S | center of sella turcica | Exact clinical marking protocol must be approved. |
| N | anterior limit of frontonasal suture | Versioned dictionary required; not a claim that every historical analysis uses identical marking. |
| A | deepest midline anterior maxillary concavity between ANS and prosthion | Contour/overlap marking needs clinician review. |
| B | deepest midline anterior mandibular concavity between infradentale and pogonion | Contour/overlap marking needs clinician review. |
| U1_TIP / U1_APEX | maxillary central incisor incisal tip / root apex | Selection among overlapping incisors must be explicit. |
| L1_TIP / L1_APEX | mandibular central incisor incisal tip / root apex | Same review requirement. |
| U1_LABIAL / L1_LABIAL | separately marked anterior/labial crown reference | Exact extremum convention and source figures remain unverified. Never substitute the incisal tip. |

The S/N/A/B anatomical descriptions have a modern primary-study dictionary witness in [2022 study, Figure 1](https://pmc.ncbi.nlm.nih.gov/articles/PMC9623223/). This does not replace review of the historical Steiner definitions or constitute validation of this implementation.

Go and Gn are excluded. Anatomical Gn and constructed Gn must not share an unqualified global identifier; notably, different definitions can occur within one named analysis. No SN-GoGn result is inferred by substituting Go-Me.

## Exact candidate measurements

For vectors u and v, the ray angle is atan2(|cross(unit(u), unit(v))|, dot(unit(u), unit(v))) in degrees, in [0, 180]. It is never silently replaced by its acute supplement.

For point P and directed line A→B, signed perpendicular distance is cross(unit(B-A), P-A). Positive is the left side of that directed line in the canonical mathematical frame. This is not a universal direction label for every unusual anatomy or rotated line.

| Measurement | Explicit construction | Evidence state |
| --- | --- | --- |
| SNA | angle(N→S, N→A) | Primary text reviewed; clinical dictionary pending |
| SNB | angle(N→S, N→B) | Primary text reviewed; clinical dictionary pending |
| ANB | SNA minus SNB | Same angular branch required; negative values preserved |
| U1_NA_ANGLE | angle(N→A, U1_APEX→U1_TIP) | Primary text reviewed; ray/dictionary clinical review still required |
| L1_NB_ANGLE | angle(N→B, L1_TIP→L1_APEX) | Primary text reviewed; lower reference is NB, not NA |
| INTERINCISAL | angle(U1_TIP→U1_APEX, L1_TIP→L1_APEX) | General branch review pending; reference Figure 3 observed |
| U1_NA_DISTANCE | signed distance U1_LABIAL to N→A | Crown extremum/figure review pending |
| L1_NB_DISTANCE | signed distance L1_LABIAL to N→B | Crown extremum/figure review pending |

ANB is not the absolute angle between NA and NB. If A and B lie on opposite angular sides of NS, or either is numerically collinear with NS, this version returns `anb-branch-ambiguous` instead of extrapolating the conventional interpretation. Incisor angles above 90° keep the raw value but are marked `needs-review`; this is a review prompt, not an assertion of abnormality or endpoint inversion.

The evidence labels record review progress only. Even `primary-text-reviewed` does NOT imply clinical acceptance. Pending evidence results can be computed to test geometry, but remain explicitly barred from clinical use.

### Primary source ledger

1. C. C. Steiner, *Cephalometrics for you and me* (1953), pp. 729–755: [publisher record / original article DOI](https://doi.org/10.1016/0002-9416(53)90082-7). Text around pp. 734–736 distinguishes crown position from the incisor long axis. Original figure inspection remains a gate; third-party text extraction is not equivalent to visual confirmation.
2. C. C. Steiner, *Cephalometrics in clinical practice* (1959), pp. 8–29: [third-party hosted text copy used for review](https://www.scribd.com/document/448977779/Steiner-1959-Cephalometrics-in-Clinical-Practice), checked for lower labial crown reference and incisal-tip-to-root axis. The host is not the publisher. Figure-level crown-extremum interpretation remains pending; no copied text or figure is included.
3. C. C. Steiner, *The use of cephalometrics as an aid to planning and assessing orthodontic treatment* (1960): [original article PDF hosted by BBO](https://bbo.org.br/bbo/files/bibliografia/artigos/56_The_use_of_cep_halometrics.pdf), particularly printed p. 723. Historical SNA 82°, SNB 80°, ANB 2° are described there; this does not establish SDs or universal age/population norms. Direct visual review of printed p. 723, Figure 3, confirmed an obtuse 131° interincisal example. This supports that reference example, but does not establish the implemented ray ordering for atypical cases. The two crown distances labelled 4 do not distinguish the exact anatomical extremum from maximum perpendicular projection. These review gates remain open.
4. [Primary-study landmark dictionary (2022)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9623223/), Figure 1, as described above.
5. DICOM spacing references above provide the pixel-unit contract, not a cephalometric magnification model.

No statistical norms, SDs, SEMs, tolerance bands, z-scores, age interpolation, severity stars, treatment suggestions or diagnosis are enabled. In particular, tolerance is not automatically SD, and SEM is not SD. A future norm package must record the original cohort, age/sex applicability, sample size, inclusion/treatment selection, statistic type, measurement/landmark definition, and image magnification basis. A missing norm must stay missing, without fallback to another population.

## Failure behavior and numerical limits

- Runtime boundary accepts unknown data and validates revision, projection, orientation, calibration and landmark identifiers.
- Duplicate IDs and malformed global metadata fail all measurements; no last-wins overwrite.
- Missing or invalid individual points fail only dependent measurements.
- Degenerate vectors, near-parallel line intersections and non-finite arithmetic are explicit errors. Valid zero point-to-point or signed perpendicular distances remain zero.
- Length guard 1e-10 and near-parallel sine guard 1e-10 are computational limits, **not clinical accuracy/error thresholds**.
- No invalid result is represented by NaN, Infinity, invented zero or fabricated landmark.
- Raw values are not rounded or classified. A future display layer may round without changing stored calculation precision.
- Caller-owned input is not mutated. No IO, eval, persistence or dependency on the legacy engine occurs.
- IEEE-754 precision and extremely large translations/aspect ratios can lose input precision; this core is not arbitrary-precision geometry.

## Synthetic verification

The golden fixture is algebraically constructed to yield 82°, 80°, 2°, 22°, 25°, 131°, 4 mm and 4 mm. These are **chosen test outputs, not a normative cohort, patient case, or independent proof of clinical definitions**.

Tests cover 0/90/135/180° geometry, tiny angles, large finite vectors, 3-4-5 and zero lengths, directed distances, projection/intersection degeneracy, explicit magnification conversion, malformed metadata, duplicates, missing points, non-finite coordinates, negative ANB, obtuse incisor review, separate crown/tip coordinates, anisotropic pixel spacing, left/right image reflection, stale calibration, no second magnification correction, immutable inputs and resampling.

A seeded test applies 500 rigid transformations with anisotropic spacing and alternating image direction and checks all 8 measurements: 4,000 invariance assertions. Ratio-only tests cover extremely small and large common factors. These establish engineering properties only; no patient accuracy, sensitivity, specificity, agreement with manual tracing, or software equivalence is claimed.

`__tests__/ceph-legacy-characterization.test.ts` intentionally captures some pre-existing behaviors, including defects, without endorsing them. It distinguishes explicit future migrations from accidental rewriting of legacy results. These tests may change in a separately approved defect-fix slice; they are not requirements to preserve defects forever.

## Legacy compatibility and migration gate

The current engine, comparison and superimposition remain untouched. Audit observations requiring separately scoped work include:

- SNGOGN currently uses Go-Me rather than the name's Gn.
- Coincident Wits projections return unavailable rather than a valid zero.
- Zero/negative legacy scales can pass some conversion paths.
- Legacy incisor distances use tip coordinates; new crown inputs cannot be synthesized from these.
- Some compound measures substitute a default palatal-plane angle when points are missing.
- Rounded display values and raw classifications can disagree near boundaries.
- Embedded tolerance may be used as SD on reference fallback.
- Comparison matches codes without a version/unit/calibration compatibility contract.
- SN registration has no explicit degenerate/non-finite landmark gate.

Do not silently relabel an old result as this new version or recompute an approved record in place. Preserve original landmarks, original results, engine provenance (or explicit unknown), calibration and audit history. A later reanalysis must be a new derived revision with reason and side-by-side comparison. Measurement codes alone never establish comparability. Protect existing adjustment visit behavior with regression tests before any future integration.

## Staged path beyond this slice

1. Resolve pending primary figures and approve a versioned landmark dictionary with an orthodontic reviewer. Independently verify all equations/ray branches and manually calculated atypical fixtures.
2. Add an explicit calibration/import adapter with provenance, image identity, transforms and review lifecycle. Keep original image geometry immutable and support correction without overwriting history.
3. Add manual tracing UI with per-point explanation, editable/reviewed state, undo/redo and overlays. Vendor workflow ideas may inform sequencing without copying protected assets. The [official WebCeph manual](https://public-assets.webceph.com/static/pdf/%5BWEBCEPH%5DUser_manual_US.pdf) is workflow background, not primary evidence for measurement validity.
4. Validate on lawfully obtained, de-identified or consented cases, with expert repeat marking and predeclared agreement/error metrics. Geometric tests do not replace this.
5. Add reference datasets only after population/statistic/magnification review, with missing-data behavior and clinician sign-off.
6. Add compatibility-aware comparison and calibration-preserving rigid/structural overlays as separate modules, not promises of growth or treatment effect from a numeric difference alone.
7. Expand named analyses with source-specific Go/Gn/Po/Pm and occlusal-plane definitions, then separately assess tracing contours, reporting, VTO and 3D. No model coefficients or predictions are inferred from vendor screenshots.
8. Integrate behind an explicit feature gate only after scientific review, security/privacy checks and relevant unit, PostgreSQL, route, print and end-to-end tests. No merge or deployment is authorized by this document.

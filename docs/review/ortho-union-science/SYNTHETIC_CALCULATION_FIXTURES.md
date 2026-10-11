# Independent synthetic calculation fixtures

All coordinates, tooth widths and cases below are invented for software verification. They are not patient records, clinical reference ranges or treatment recommendations. Expected values were worked from the stated equations, independently of the application. No test runner or app was executed. The implementation owner must convert these into tests against the current formula versions.

Use a documented floating-point tolerance for unrounded arithmetic, for example 1e−9 for these small fixtures, separately from display rounding. This numerical tolerance is not an allowable clinical measurement error.

## G01. Euclidean calibration

Calibration endpoints C1 = (0,0), C2 = (100,0) source pixels; known marker length = 25 mm.

- Scale = 25/100 = 0.25 mm/pixel.
- Measured endpoints P = (10,10), Q = (40,50).
- Pixel distance = square root of (30² + 40²) = 50 pixels.
- Expected physical distance = 50 × 0.25 = 12.5 mm.

Doubling every coordinate makes the calibration marker 200 pixels and scale 0.125 mm/pixel; the result remains 12.5 mm. Translation and rotation must also preserve it. Pan/zoom are display transforms, not new anatomical measurements. Invalid/missing calibration must not produce a fabricated 0 mm.

Basis: E14 in the evidence register; arithmetic is elementary geometry.

## G02. Anisotropic pixel spacing and angle preservation

DICOM Pixel Spacing = row 0.25 mm, column 0.50 mm. x counts columns; y counts rows.

- Displacement = (6,16) pixels.
- Physical displacement = (6 × 0.50, 16 × 0.25) = (3,4) mm.
- Expected length = 5 mm.
- A pixel vector (1,1) makes 45° on a square-pixel display but represents (0.50,0.25) mm. Its physical angle to +x is arctan(0.5) ≈ 26.565051177°.

A scalar scale cannot recover both dimensions unless a documented resampling/normalization has already established an isotropic metric. Angles are invariant to uniform scaling, not arbitrary anisotropic scaling.

Basis: E14 and direct geometry. Do not silently add DICOM import scope if the application accepts only other image formats; instead require the corresponding source-coordinate metric contract.

## G03. SNA/SNB vertex and signed ANB

In an isotropic coordinate system, use N = (0,0), S = (−10,0), A = (0,10), B = (−5, 5√3).

- SNA is the angle between N→S and N→A: 90°.
- SNB is the angle between N→S and N→B: 60°.
- Signed ANB = SNA − SNB = +30°.
- Swap A and B: signed ANB = −30°.

These deliberately non-clinical angles expose vertex errors, unsigned absolute differences and premature rounding. A repeated endpoint producing a zero-length ray is unavailable, not a valid 0° angle. Three distinct collinear points may produce a valid 0° or 180° according to the chosen ray directions; decide explicitly rather than treating all collinearity as missing data.

Basis: E03 illustrations and E06 definitions. The actual calculation contract must retain the chosen ray/angle convention.

## G04. Wits positive, negative and zero

Occlusal plane endpoints: posterior P = (0,0), anterior Q = (100,0). Scale = 0.25 mm/pixel. The unit vector toward the anterior is u = (1,0).

1. A = (20,−10), B = (8,15). AO = (20,0), BO = (8,0). Signed Wits = (AO−BO) dot u × 0.25 = 12 × 0.25 = +3 mm.
2. Swap A and B. Expected −3 mm.
3. A = (20,−10), B = (20,15). Both projections are (20,0). Expected exactly 0 mm, with a valid plane and distinct anatomical points.
4. Set P = Q. Expected unavailable/invalid plane, even if A and B remain distinct.

Use the plane direction to establish sign, not the AO–BO displacement itself. When mirroring or rotating the displayed image, transform the anatomical anterior direction consistently. An x-coordinate heuristic alone is not a general anatomical orientation contract.

Tilted check: posterior P = (0,0), anterior Q = (3,4), so u = (0.6,0.8). A−B = (10,5) pixels. Signed projection = 10×0.6 + 5×0.8 = 10 pixels; at 0.2 mm/pixel, expected +2 mm. The perpendicular components do not contribute.

Basis: E03. The fixture presumes the selected occlusal plane has already been defined and approved.

## G05. Distinct mandibular-plane definitions

S = (0,0), N = (10,0), Go = (0,10), Gn = (10,20), Me = (10,10).

- Angle between S→N and Go→Gn = 45°.
- Angle between S→N and Go→Me = 0°.

This is a naming/dependency regression fixture. SN–GoGn and SN–GoMe cannot be presented as the same measurement. It does not choose a reference mean for either variant. A change to landmark definitions or plane selection requires a new definition/formula identity for historical comparability.

## G06. Triangle consistency

For a declared Tweed internal-angle convention, synthetic FMA = 25° and IMPA = 95° imply FMIA = 180 − 25 − 95 = 60°. Sum = 180°.

This identity is a consistency check, not a substitute for testing the correct ray choices in each direct geometric measurement. Do not force incompatible independently calculated angles to agree by silently clamping a negative result.

Basis: E05.

## B01. Bolton anterior, both residual directions

FDI tooth inputs, all mm:

- Upper IDs [13,12,11,21,22,23], widths [8,7,9,9,7,8]: U = 48.
- Lower IDs [43,42,41,31,32,33], widths [6,5,7,7,5,6]: L = 36.
- Ratio = 100 × 36/48 = 75%.
- Explicit historical reference = 77.2%, therefore r = 0.772.
- Holding U fixed: expected L = 48 × 0.772 = 37.056 mm; L − rU = −1.056 mm.
- Holding L fixed: expected U = 36/0.772 = 9000/193 mm ≈ 46.6321243523 mm; U − L/r = 264/193 mm ≈ +1.3678756477 mm.

The two residuals differ in scale and sign; they are not contradictory and must not share an ambiguous “excess” field. Neither result is an instruction to modify that amount of tooth material.

Exact-reference check: U = 50 mm and L = 38.6 mm gives 77.2%, with both residuals zero. These totals can be assembled from any explicitly valid six-tooth synthetic input set for an end-to-end fixture.

Basis: E01, pp. 507–508 and 517.

## B02. Bolton overall tooth-set contract

Upper FDI IDs [16,15,14,13,12,11,21,22,23,24,25,26], each width 10 mm: U = 120 mm.

Lower FDI IDs [46,45,44,43,42,41,31,32,33,34,35,36], each width 9.13 mm: L = 109.56 mm.

Ratio = 100 × 109.56/120 = 91.3%; at explicit reference 91.3%, both residuals are zero. The deliberately uniform widths are synthetic arithmetic inputs, not plausible dentition guidance.

Negative cases: remove a required tooth; duplicate an ID; insert a second molar in place of a first molar; mix primary and permanent IDs; use zero, negative or non-finite width. These must be rejected or explicitly unavailable, not completed with a mean, zero or the opposite side. Array reordering must not affect totals.

## S01. Permanent-arch discrepancy sign

Use the existing upper ten-tooth set [15,14,13,12,11,21,22,23,24,25], each 7 mm. Required = 70 mm. The available-space path must refer to this same segment.

- Available 65 mm → available − required = −5 mm.
- Available 70 mm → 0 mm.
- Available 75 mm → +5 mm.

These are numerical shortage/balance/surplus descriptions only. Do not attach extraction, expansion, IPR or surgery instructions. Do not mix this ten-tooth set with the twelve-tooth Bolton overall set.

Basis: E07 and E09; the sign is the explicit application contract.

## M01. Mixed-dentition mean versus percentile approximation

Measured lower incisor widths 5.5, 5.5, 6.0, 6.0 mm give X = 23 mm.

- Approximate 75th-percentile rule: upper quadrant 11 + 23/2 = 22.5 mm; lower quadrant 10.5 + 23/2 = 22.0 mm.
- Lower predicted ten-tooth total = 23 + 2×22 = 67 mm.
- Original regression-mean equations instead yield upper 10.41 + 0.51×23 = 22.14 mm; lower 9.18 + 0.54×23 = 21.60 mm.

A fixture expecting 22.5 must not pass against the mean equation. An upper-arch total additionally needs the upper-incisor measurements. A per-quadrant result must not be displayed as an entire arch. Unsupported/out-of-table X must not be silently clamped or extrapolated. Clinical applicability remains unapproved.

Basis: E02. This is an arithmetic fixture, not authorization to enable a presently disabled prediction method.

## R01. Agreement-calculation semantics

Three invented paired differences, consistently defined as software minus comparator: [1,2,3] mm.

- Mean difference = 2 mm.
- Sample SD = square root of ((1+0+1)/(3−1)) = 1 mm.
- Arithmetic limits = 2 ± 1.96×1 = 0.04 to 3.96 mm.

This tiny dataset tests formula implementation only; it cannot validate a device or estimate clinically acceptable limits. Keep sample SD distinct from standard error. Reversing subtraction order reverses bias and limits. Do not substitute a correlation coefficient for agreement.

Basis: E13.

## Workflow invariants to test after the arithmetic

- Preview, server recomputation, persisted report and export use the same declared definition and formula version.
- Editing landmarks, calibration, source image or reference set invalidates derived approval while preserving the prior signed version.
- Display rounding and translation do not change stored values or sign.
- Missing and unsupported remain visibly distinct from zero; prediction remains distinct from measurement.
- No treatment recommendation is generated by these fixtures or by a ratio/angle threshold.

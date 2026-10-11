# Historical source inspection against scientific contracts

Review date: 11 October 2026. Static inspection only. These are recovered/saved snapshots, not a fresh checkout or evidence of the currently deployed Railway application. The implementation owner must compare the findings with its current head before changing code. No source implementation was edited and no app/tests/build/SQL were executed.

## Source identities

1. `/workspace/shared/recovery-20261011-0105/publisher/source/OrthoFirstFinalFiles/lib/ceph.ts`
   - SHA256: `7c9c592f7e698a33099efbb603f94c490df08d2eebfab5b673ad4cee8a83fa07`
2. `/workspace/shared/recovery-20261011-0105/lead/retention-document-composition-v1/overlay/lib/ortho-assessment-arithmetic-2_1_0.ts`
   - SHA256: `ec0ff7d102cd0e69c0454f5cc8c611acc9773f63e65252ba2150132759678dc0`
3. The same overlay's `lib/ortho-assessment-engine-2_1_0.ts`
   - SHA256: `094e7c236fb7b8f3ac7988f0cc63e3f362a72b547252265851d4e3b45fbc237f`

## Findings with direct support

### F01. A valid Wits zero is treated as unavailable

In `ceph.ts` lines 374–379, the direction is constructed from the AO–BO displacement. Its length is zero when projections coincide, and the code returns NaN. This is a valid 0 mm Wits result for a non-degenerate occlusal plane, as illustrated in Jacobson's original article (E03, pp. 130–131).

Use the separately defined plane/anterior direction for a signed projection, and reserve invalidity for a degenerate plane, missing input or invalid calibration. Proposed fixtures G04 cover +3, −3, 0 mm and a degenerate plane. This is a source-confirmed mathematical case; it was not executed in the application.

### F02. SN–GoGn label uses Go–Me operands

The measurement at line 302 is named SN–GoGn but declares Me rather than Gn. Lines 395–397 likewise calculate S→N against Go→Me. These are distinct landmarks within the same source (lines 137–138); this is an internal label/operand mismatch, not a dispute about a population norm.

Resolve the intended protocol explicitly: either a properly named SN–GoMe variant or the verified SN–GoGn definition with Gn. Do not silently change historical saved values under an unchanged measurement identity. Fixture G05 makes the difference observable without invoking clinical reference ranges. Full original Steiner-method audit remains open in this research, so the correction must not be described as verification of every Steiner reference.

### F03. Wits plane identity is ambiguous

The Wits analysis description calls the plane functional, while OcclA's landmark guidance (line 144) puts the anterior point between the incisor edges. E03 describes a plane through maximum cuspal interdigitation; E04 explicitly studies functional and bisected variants. A named plane protocol is required before treating measurements/references as comparable.

This does not establish that every incisor-based variant is invalid. It establishes that the existing label and generic point instructions do not specify an unambiguous functional-plane contract.

### F04. Scalar calibration has a conditional assumption

`computeMmPerPixel` uses one known length divided by Euclidean source-pixel distance. This is appropriate for an isotropic source metric. The accompanying statement that angles need no calibration must be qualified: uniform scale cancels, anisotropic scale does not. E14 specifies separate row/column spacings. G02 supplies a synthetic counterexample.

No claim is made that the current upload pipeline actually accepts anisotropic images or mishandles them. Verify the supported image/coordinate contract and fail safely if an isotropic metric cannot be established.

## Positive observations to preserve

- The assessment arithmetic's Bolton numerator is lower/upper, with separate six- and twelve-tooth sets. Its two residual formulas agree algebraically with E01. The arithmetic helper requires an explicit reference percent.
- The assessment engine separately marks clinical approval unapproved. It leaves unsupported methods unavailable pending exact protocol/reference review rather than guessing a result.
- The permanent-space helper uses an explicit available-minus-required sign and a defined ten-tooth set.
- Historical arithmetic and engine files are versioned. Preserve those versions; introduce corrected successor contracts rather than rewriting prior approved calculations in place.

## Provenance gaps, not established formula failures

The recovered Ceph dictionary contains many short source labels such as Steiner/WebCeph and combined `mean`/`tol` fields. This review did not verify all 49 measurements, original tables, statistical meanings, age/sex/population applicability or treatment-oriented descriptions. Their numeric values are not declared wrong merely because the supporting article was inaccessible. They remain unverified here.

E01 independently confirms the archived assessment engine's cited Bolton 1962 formula pages and historical means. That source verification does not confer clinical approval or universal population applicability.

Keep extraction/surgery/other treatment-decision text out of automatically generated conclusions unless separately governed by an approved clinical workflow. This review supplies no automatic decision rules.

## Required handoff result

Compare these exact snapshots to the current owner head; add the applicable independent fixtures; correct surviving defects using new versioned definitions where needed; run the authorized application and persistence tests in the assigned environment. Report actual execution evidence separately from this scientific/static review. No claim of current CI or Production verification is made here.

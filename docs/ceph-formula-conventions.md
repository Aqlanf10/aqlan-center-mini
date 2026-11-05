# Cephalometric calculation conventions and limits

This implementation records reviewed geometric definitions, not clinical certification. Fixtures contain synthetic landmarks only. Landmark identification, image projection/distortion, calibration quality, reference-population applicability and treatment decisions still require qualified clinical review.

## Corrected definitions

- INTER: angle between the upper and lower apex-to-incisal-edge vectors, U1A→U1 and L1A→L1. Both vectors must be nonzero. Do not subtract from 180 degrees or automatically force the result acute/obtuse. The lower root is anatomically inferior to its edge. The previous regression fixture reversed that anatomy; its endpoints were corrected without changing the independently verified IMPA or FMIA formulas.
- SN-GoGn: angle between S→N and Go→Gn. Go→Me remains the separate mandibular-plane convention in FMA, IMPA and AB_MAND.
- WITS: dot(A−B, unit(OcclP→OcclA)) multiplied by positive mm/pixel. Coincident A/B projections produce valid zero. Coincident occlusal reference points are undefined. Anatomical posterior/anterior endpoint ordering defines the sign, not screen x.
- FH_AB: the posterior wedge between Or→Po and A→B, consistent with this field's existing intended interpretation. A generic name such as “FH/AB” alone would not specify a supplementary wedge.
- PP_FH: signed tilt from Po→Or to PNS→ANS in the anatomical frame. Forward-down palate is positive; forward-up palate is negative.
- ODI: angle(A→B, Go→Me) + signed PP_FH.
- APDI: the posterior/downward wedge angle(ANS→PNS, A→B). It can exceed 90 degrees. This direct construction requires no FH or orientation anchors and is invariant under rigid rotation/reflection.
- CF: ODI + APDI. Actual palatal landmarks are required. A missing or degenerate plane never becomes a population-average 3 degrees.

## Signed orientation contract

S→N defines posterior-to-anterior and Me lies anatomically inferior to SN. The handedness of (S→N, N→Me) supplies the sign convention for cross-product-based measurements. It reverses under image reflection and is invariant under rotation/translation. Properly placed lateral landmarks are assumed; the engine cannot certify their anatomical correctness or diagnose mislabeled points.

Signed offsets, signed Downs angles, overbite and PP_FH require finite, noncollinear S, N and Me. Their dependent outputs are unavailable when that frame cannot be determined. A scale-aware floating-point roundoff bound rejects a numerically indeterminate cross product, including a collinear triple after rotation. It is not a clinical minimum-angle or acceptable-error threshold.

The SN overlay also requires this frame in each image. Opposite-handed images are refused: rotation alone cannot align a mirror image. The caller must normalize the image and its landmarks together. Physical mm/pixel calibration is retained independently for both images; SN lengths are never scaled to match, preserving growth.

## Unavailable and quarantined values

Invalid/nonfinite/zero-length reference geometry returns unavailable, not zero. Genuine zero measurements remain valid. Calibration and linear conversion require finite positive scale and finite representable results. Live calculation and round-trip serialization use the same engine; output rounding to 0.1 is presentation precision, not a statement of clinical accuracy.

EXT_INDEX is quarantined. The former CF+(nasolabial angle−95)×0.5 formula and missing-soft-tissue fallback have no verified clinical definition in this review. The engine emits no numerical value or extraction recommendation for it, and the comparison helpers exclude even finite historical EXT_INDEX values. Its explanatory unavailable notice must remain visible. Existing stored records are not rewritten or deleted. Current presentation consumers must not restore a historical quarantined value as a validated result.

Existing population means, diagnostic thresholds and other narrative treatment rules were not clinically validated by these repairs. No substitute extraction formula is proposed. Historical snapshots of other measurements retain their original meaning; a formal versioned clinical correction/review process is outside this change.

## Definition sources

- Heil et al., Table 2, SN/GoGn, incisor axes and Wits: https://pmc.ncbi.nlm.nih.gov/articles/PMC5363936/
- Xia et al., line-line angles and interincisal example: https://pmc.ncbi.nlm.nih.gov/articles/PMC3059215/
- Caballero-Purizaga et al., Kim ODI/APDI measurement definitions and signed palatal tilt, doi:10.1590/2177-6709.24.3.046-054.oar: https://pmc.ncbi.nlm.nih.gov/articles/PMC6677332/
- Celar et al., posterior/downward APDI wedge, doi:10.1007/s00056-018-0139-z: https://link.springer.com/article/10.1007/s00056-018-0139-z
- Obamiyi et al., APDI equivalence and sagittal direction: https://pmc.ncbi.nlm.nih.gov/articles/PMC8109155/

## Verification

`__tests__/ceph-formula-safety.test.ts` covers independently derived wedges, missing dependencies, finite/degenerate geometry, exact zero WITS, calibration overflow/underflow, full rotations, reflection, scale, signed-orientation ambiguity, unsupported mirrored overlays, physical growth preservation, serialization, references and quarantined historical comparisons. Existing ceph, compare, overlay and consumer regression suites also run. Final acceptance requires tests against the integrated frozen candidate and clinician review; these checks are not evidence of Production deployment or clinical certification.

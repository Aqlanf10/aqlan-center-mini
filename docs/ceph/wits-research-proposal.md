# Directed projection proposal, not clinical Wits

Definition: `wits-directed-projection/0.1.0-research`.
The prototype computes `(A-B) dot unit(anterior-posterior)` after independent
axis calibration. Anatomical endpoint identities travel with an image mirror or
rotation; no screen-x heuristic and no normalization of the AO/BO separation.
Zero is a valid result for a valid nondegenerate plane.

Only synthetic-grid calibration and a synthetic-directed-line construction are
accepted. This deliberately cannot be substituted for detector or patient-plane
calibration. Every result carries `clinicalUseAllowed:false`, no norms, and an
explicit definition ID. It has no production callers, persistence or migration.
Legacy WITS and stored reports are unchanged; any future clinical integration
requires an explicit new-definition recalculation with preserved originals,
never re-labeling/reinterpreting old values.

96 targeted tests pass, including zero, signed separation, plane rotation,
reflection, anisotropic image-resize calibration, invalid geometry and rejection
of patient-plane substitution. Lint and scoped typecheck pass. These tests show
synthetic arithmetic only; original functional-plane construction review,
landmark observer reproducibility, calibration validation, clinical reference
fixtures and independent clinical review remain blockers. The original Jacobson
1975 abstract supports perpendicular projection onto the occlusal plane, but it
is insufficient for clinical activation of this prototype.

## Follow-up verification

99 targeted tests now pass. Compound cases explicitly verify zero and negative
separation after horizontal and vertical reflection, both in the test-only
projection witness and the versioned proposal. For the oblique line y=x+10,
independent simultaneous Cartesian line equations give AO=(22.5,32.5) and
BO=(35,45) for A=(5,50), B=(0,80). Tests check both coordinates, line incidence
and perpendicularity rather than relying only on the resulting separation.

This closes the listed arithmetic test gaps only. Clinically locating the
functional occlusal plane remains unvalidated; these arbitrary synthetic lines
are not anatomical landmark constructions and must not be presented as such.
No legacy code, stored result, application integration or clinical gate changed.

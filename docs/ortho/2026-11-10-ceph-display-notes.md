# Cephalometric display-note correction — 2026-11-10

The FMA note in `lib/ceph.ts`, displayed by the tracer, attributed higher values to horizontal growth. The YAXIS_FH note also combined conflicting vertical/horizontal wording. Both now describe their measured planes and leave growth/treatment interpretation to the clinician.

This changes two display strings only. FMA still uses FH (Po–Or) against Go–Me; SN–GoGn still uses S–N against Go–Gn; YAXIS_FH still uses S–Gn against FH. Formulas, required landmarks, finite/degenerate geometry checks, calibration, units, school memberships, reference means/tolerances, thresholds and saved data are unchanged.

The original Downs paper defines the Frankfort and mandibular planes and the S–Gn axis; its mandibular-plane discussion describes inclination rather than establishing an individual treatment decision. The publisher endpoint was unavailable (403); the readable reproduction of the original paper was inspected. Sources: [Downs1948 publisher record](https://www.sciencedirect.com/science/article/pii/0002941648900153), [original-paper reproduction](https://www.academia.edu/24407402/Variations_in_facial_relationships_their_significance_in_treatment_and_prognosis).

Validation: the existing `ceph-formula-safety`, `ceph-narrative-safety` and `ceph` suites passed99/99. Independent source review confirms only the two notes changed. This is not a new clinical rule or full scientific validation of every measurement.

Remaining limitation: the shared FMA row appears in the Downs group while its current reference label is Tweed/WebCeph. Separate analysis-specific reference provenance and population applicability still require review; this display correction does not certify a complete Downs reference set. No quarantined calculator was enabled.

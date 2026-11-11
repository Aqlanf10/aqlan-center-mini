> Historical preservation note (2026-11-11): recovered from Staging commit `779bf35`. This document records its original review context, not current deployment state or authorization. Branches, migration prerequisites and commands below must be revalidated against the selected candidate and target before use.

# Dose profile v2 — new local candidate, not recovered bytes

Base: published `fab4d29dd262eb1421492fd11fc190c0986d00c1`.
This is a new implementation after the volatile workspace changed. It does not
claim the earlier unpublished tree or hashes. No owner, identity, grant,
migration, Stage or Production changes are included.

## Scope and source

Six supported mathematical adapters out of 24 references: the four existing
adapters plus adult/child SDCEP ibuprofen. No automatic antibiotic selection.
Primary source re-read 2026-11-02:
https://www.sdcepdentalprescribing.nhs.scot/guidance/odontogenic-pain/analgesics/ibuprofen/
The adult example remains 400mg four times daily for five days, not an automatic
escalation to the 2.4g ceiling. Children use the source age bands and 30mg/kg/day;
from seven years the absolute ceiling also applies. Do not borrow 40mg/kg/day
from a different guideline. The selected schedule must not exceed the actual
product label count or violate its minimum interval. The source page supplies no
minimum interval; no label values are inferred or preselected. After-food
instructions are included. NSAID contraindications/interactions and special
populations still require clinician review; checking a box is not medical proof.

## Versioning and integrity

The existing v1 parser text and valid v1 snapshot/command/acknowledgement bytes
are pinned against the verified published source. v2 uses a separate bounded
shape with explicit ingredient and product schedule. Stored history is parsed
structurally; only NEW issuance invokes current clinical semantics. Existing
transaction authorization, receipt replay order and atomic audit remain unchanged.
Manual edits retire calculated provenance and require fresh confirmation.
New calculations reject non-finite, unsafe or zero-rounded measurement tick
counts; this is numerical representability, not an invented clinical threshold.

## Evidence gates

Local focused tests and bounded strict typecheck are distinct from full CI.
Available local Vitest is4.1.11 rather than the published lock's4.1.12; no install
was performed. Exact project lint could not load the older local hooks-plugin
export shape; an evidence-only compatibility config selects its existing
recommended-latest export without changing repository config or rules. Full
locked-toolchain lint/typecheck remain required on the eventual exact head.
Native v1/v2 replay/tamper/revocation, actual browser issuance/recovery and A6
fixtures are extended but NOT executed locally. Four explicit synthetic saved
print artifact paths are added; no broad uploads or patient snapshots in logs.
Fresh exact-head full CI/image/native/browser/PDF is required. Prior fab4 green
cannot be inherited by this candidate. Remaining18 references are not completed
calculators; owner canonical cutover remains blocked independently.

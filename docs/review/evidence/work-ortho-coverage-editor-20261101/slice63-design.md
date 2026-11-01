# Proposed next bounded contract: coverage source context and native editor

Base will be the validated slice62 command, not a fresh implementation. No product edit started in this design note.

- Add explicit canonical GET editing context (`edit=1`) separate from the existing minimal saved-decision projection. POST/PUT must continue rejecting unrelated query keys. Use the same fenced read-only snapshot, 256/2MiB native source query and exact fingerprint.
- Source choices expose invoice/service labels plus the exact plan/case/item identities needed by the existing command. These labels and identities require the independent current invoice-view and clinical-plan-view grants in addition to agreement management and patient scope. Owner retains all. No inferred invoice/plan grant from clinical ortho access; no hidden monetary/clinical snapshot.
- Keep the ordinary saved-decision reader usable without source-view grants. Explicit editor requests without them fail closed. Do not create a financial-only navigation product or broaden unrelated roles.
- Reuse the existing `OrthoFollowupCoveragePanel` journal/receipt/recovery engine through an explicit canonical adapter. Preserve the compatibility caller and its native schema. Strict canonical context parser, session/capability ownership key, immediate clearing on refresh/hide/failure, stale-result guards and finite read/write deadlines.
- Shared durable actor/patient journal arbitrates financial workflows/tabs; fail before sending when storage is unavailable. No automatic retry. Explicit status must verify the exact terminal receipt before retiring a pending command; generic409/500 or unresolved must retain it. Explicit replay is the identical durable native command.
- Preserve current RTL identity and 390px layout. Show scope semantics and clear synthetic fixture proof; signed historical visits and money unchanged.
- Gates: causal old-build query rejection; PostgreSQL scope/independent-grants/fenced snapshot/limits/no effects; native journal unit regressions; built HTTP and Chromium edit, response loss, reload recovery, cross-tab arbitration, revoked access, pending source change and late response; full final-source CI and independent review. No migration, live activation, deployment or Rx work.

This is an initial implementation boundary from existing field-level permissions, not acceptance of a new financial policy. If the existing contracts require a different source-identity visibility rule, resolve that specific part before implementing it.

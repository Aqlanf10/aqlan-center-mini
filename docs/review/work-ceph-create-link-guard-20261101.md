# Close the optional orthodontic link boundary

On local slice59 source `a9a75d8`, a direct canonical ceph-create request with an owned orthoCaseId succeeded for an image uploader lacking `clinical.ortho.view`. This contradicted the independently gated case chooser being added in slice60. The causal PostgreSQL witness expected capability refusal and received a new study instead; no production incident is claimed.

The command now checks the independent view grant using the fresh admitted operation before reading or locking that case. Empty-link creation remains available under its original upload grant. Protected owner and scoped authorized links retain the native insertion, calendar values and audit. No new capability, widened scope, copied clinical result or financial effect.

All **23 command PG cases** passed in the corrected run (39 total including 16 separate, then-uncommitted choice-reader tests). The first revocation fixture introduced an inverse user/patient lock deadlock; the corrected witness uses the actual exclusive identity fence and proves stale-request and fresh-request refusal with no effects. It does not change the runtime or relax an assertion to accept the deadlock. Actual HTTP denial and protected-owner success passed as part of the slice60 final build and are recorded with that UI integration, not misattributed to this isolated commit's build. Combined gates and independent review remain pending.

Original before/after logs are retained in [slice60 evidence](evidence/work-ceph-create-ui-20261101/manifest.json). This is a corrective local commit before publication, not acceptance of the preceding source on the strength of its earlier passing full suite.

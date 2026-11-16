# Canonical inventory reference reader (unbound)

`readCanonicalInventoryReferences` is the first bounded inventory canonical runtime
binding, not an HTTP activation. It owns a READ COMMITTED transaction and requires
an opaque `VerifiedDurableSession` plus exact `inventory.references.view` admission.
The protected owner retains existing central semantics; every other supported active
role needs the explicit grant. There is no `staff.view` prerequisite or admin fallback.
The capability document schema remains 1; authorization policy is now 3, so old-policy
signed durable sessions fail the strict parser. No token issuer or grants are installed.

The runtime locks central lifecycle, control, identity, user and provider authority
before the reader takes the shared purchase-reset fence. After that potentially
blocking fence, a fresh exact handle/client/action/XID assertion returns frozen
realm/subject/generation provenance and DB-backed user ID/username/role audit fields. A final runtime assertion precedes commit and
failure discards facts. Provenance is never accepted back as authorization.

Facts are restricted to paged item/package units, store/transit/custody locations,
doctor IDs/names and approval-policy settings. Items remain 20/page; locations and
doctors fail rather than truncate above 500. `allowedActions` includes only `item.create` when a bounded fresh read-handle preview
proves `inventory.items.create`; the read handle never authorizes mutation. Read-only
delegates receive an empty list. There are no readiness counts, financial history,
stock/value facts or writes in this reader. Canonical
reference SQL is qualified to the same validated schema as central admission and
does not trust the connection search path. Missing relations fail explicitly; this
is not a full inventory-schema provenance attestation.

The old setup service retains its existing admin/journal mutation checks. Its SQL
sharing is private. Default reference HTTP transport, other setup commands, readiness,
supplier/recovery adapters and rollout activation remain closed. Existing positive
supplier/recovery journeys are unchanged and remain later adapter acceptance work.

Synthetic real-PostgreSQL tests construct a hypothetical ready-v2 fixture only;
they establish neither a production bootstrap procedure nor authority to activate
accounts. No production issuer, marker, credentials or schema installation is added.

The separately owned server-only item-create lifecycle is described in
[canonical-inventory-item-create.md](canonical-inventory-item-create.md).

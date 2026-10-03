# Document association integrity

## Contract

The upload route checks association ownership before `putFile`. `recordDocument`
repeats the same DB-client-aware validator inside the metadata insertion
transaction, protecting every caller (HTTP upload, verification and restore-drill
fixtures). Authorization remains with the existing patient-access guard.

- The document patient must exist
- Explicit visits must exist and belong to that patient; an unlinked visit is not evidence of ownership
- Explicit orthodontic cases must belong to the patient
- An adjustment must resolve through its actual case to the same patient
- An adjustment's non-null visit must belong to the same patient
- Explicit case/visit IDs must agree with the adjustment's actual links
- Patient-only, visit-only, case-only and adjustment-only documents remain valid
- An adjustment with no historical visit may be used without supplying a visit
- A case plus same-patient visit does not imply a historical adjustment
- Omitted associations stay omitted; no historical links are inferred or written
- Signed visits and closed cases may still receive documents

Missing, foreign, unlinked and mismatched references produce the same opaque
`DocumentAssociationError` and HTTP 400. Malformed explicit IDs are rejected,
not silently converted to missing IDs. Empty optional multipart fields remain
compatible with omission.

## Atomicity and lock order

The validator first locks the patient with `FOR KEY SHARE`, matching the
parent-first order of patient merging/deletion and obtaining the eventual INSERT
foreign-key lock before child locks. It then reads the adjustment's identity,
locks its referenced visit, then its case, then re-reads/locks the adjustment. This matches the existing
visit signer and `recordAdjustment` parent order and the visit-deletion path.
`FOR SHARE` blocks non-key ownership/link changes; `FOR KEY SHARE` would not.
The post-lock identity check rejects a concurrent adjustment move rather than
acquiring a different parent out of order. All locks survive the document INSERT
until the transaction commits. Ordinary non-key patient edits stay compatible
with the patient key-share lock. There is no storage write for a known invalid
association. A change after preflight can leave content-addressed orphan bytes
when the atomic DB check rejects it. Do not delete the shared storage key: another
valid document can own those same bytes.

## Existing records

`photosForAdjustments` and `listOrthoCasePhotos` project only internally coherent
links. They exclude legacy mismatches across the document, visit, case and
adjustment owners without updating, repairing or deleting any historical row.
An adjustment-only document remains in that adjustment's album; it is not
invented into a case album when its explicit case link is absent. Direct document
access continues to use `document.patientId` authorization.

This is an application write-boundary and read-projection fix, not a schema
constraint or a redesign of later relinking operations. A later authorized
reference mutation may make existing links inconsistent; album projections
continue to fail closed in that situation.

## Verification

Dedicated suite: `__tests__/postgres/document-associations.test.ts`.
Run with Node 22 and PostgreSQL 18 through the normal `test:postgres` configuration
against an explicitly disposable loopback database. The suite invokes the
canonical target guard before environment stubbing or destructive test setup.
The local proof runner creates a fresh cluster, disables Unix sockets, binds
127.0.0.1 only, and traps server shutdown.

Coverage includes optional/closed/signed compatibility, opaque errors, no-byte
preflight rejection, late post-storage races, raw legacy corruption fixtures,
visit/case ownership races, stale adjustment identity after parent-lock waits,
actual patient-merge/deletion overlap in both lock directions, and real
PostgreSQL lock observations proving that non-key changes to all three
associated rows wait until document insertion commits. Historical fixture rows
are checked byte-for-byte unchanged after read projection.

Built-server coverage: `__tests__/security-http/document-associations-http.test.ts`
uses the existing isolated security-HTTP harness with real login cookies, multipart
requests, PostgreSQL and document storage. It covers valid same-patient upload and
byte-for-byte download, foreign download denial, opaque invalid-association
responses and unchanged metadata counts. The PostgreSQL suite above exercises the
real DB and route but mocks authentication and storage; it does not replace this
built-server HTTP gate.

# Preparatory staff authority boundary

This slice is inert groundwork. It does not restrict live managers/reception, add
administrative access to doctors, authenticate accounts or enable canonical profiles.
No route, session, proxy, user writer, startup linker, owner binding or database schema
uses the new adapter. The existing capability catalogue and resolver remain the only
canonical policy. No second permission store, role mapping or evaluator is introduced.

## One raw envelope classifier

`lib/staff-permission-envelope.ts` is browser-safe. The foundation re-exports the
existing canonical parser from this module, so existing imports remain valid and there
is no duplicate canonical validator. The legacy review adapter uses the same classifier
before invoking the existing permissive legacy parser.

- SQL NULL, missing input, the empty string and JSON `null` retain legacy defaults
- An empty object and ordinary JSON legacy records retain the existing parser's flag
  semantics, including ignored unknown fields and ignored non-boolean toggle values
- The classifier does not invent a new legacy permission schema or claim every legacy
  flag is enforced by every route
- Every top-level canonical field (`schemaVersion`, `revision`, `patientScope`,
  `appointmentScope`, `grants`) selects the strict canonical parser. Missing/mixed fields,
  unknown versions/grants/scopes and missing prerequisites fail closed, with no admin
  fallback. A valid canonical document is classified, not activated
- Other scalar values, malformed/whitespace-only JSON, inherited/accessor/hidden/symbol
  properties, prototype keys, non-JSON nested values and cyclic/deep data are invalid
- Legacy data is copied and frozen recursively. Text is limited to 16,384 characters;
  object input must also fit that serialized limit. This bound is a storage safety
  contract, not an authorization rule

The public `parseDoctorPermissions` implementation and all live callers are unchanged.
Consequently malformed live legacy storage is **not yet quarantined at runtime**.
Before wiring this classifier into authentication, run the separately authorized
read-only existing-profile preflight and resolve unexpected legacy records explicitly.
Do not silently normalize or rewrite them.

## SELECT-only observation contract

`lib/staff-authority-snapshot.ts` is marked `server-only`. Its injected query interface
performs exactly one parameterized SELECT by `users.id`, with a LEFT JOIN to the stored
party. There is no username/name lookup, active-row filter, default owner, connection
factory, `ensureSchema`, cache, lock, write or repair. An authorized caller must establish
why it can inspect that immutable ID; passing an ID is not authentication.

The loader returns an opaque process-local snapshot. Its credential-version source and
raw permission storage remain private, with no raw getter. JSON serialization, object
spread and the explicit diagnostic summary cannot disclose them. Copied/forged handles
cannot recover the private state. Future authentication integration will need its own
reviewed narrow credential operation; this slice does not introduce one.

The allowlisted summary reports:

- `legacy-unverified`, `canonical-quarantined`, or `denied`, never authenticated/allowed
- Unknown roles, inactive accounts, invalid envelopes and inconsistent link evidence
  explicitly; all canonical roles remain quarantined even with every grant present
- Stored party ID separately from effective clinician ID. Only a matching active doctor
  party supplies an effective ID. Missing/non-doctor/inactive parties supply none; no
  cookie fallback, inferred link, party creation or account role change occurs

Inactive targets remain observable. Lookup failures, malformed row shape, duplicate or
mismatched IDs fail closed and do not disclose query/error text. Each call reads afresh;
this is not a transaction or revocation guarantee. The legacy review method reuses the
existing review report, which lists observed legacy flags only and grants no access.

This party-joined loader is not a proposed replacement for backup recovery's minimal
SELECT-only user check. Backup quarantine must classify raw permissions without adding
unnecessary clinician-table dependencies.

## Verification and later gates

Focused tests cover legacy parser parity for every role, canonical/malformed/mixed
markers, deep object safety, parser identity/browser bundling, all-role quarantine,
SELECT shape and ID binding, inactive/unknown/invalid identities, missing/inactive/wrong
party links, no raw-secret projection, forged handles and uncached snapshots.

```sh
npx vitest run __tests__/staff-permission-envelope.test.ts \
  __tests__/staff-authority-snapshot.test.ts __tests__/staff-capabilities.test.ts
```

Before release, run the repository's exact-head CI gates. Focused unit/query-stub tests
are not PostgreSQL, HTTP, browser or Production evidence. This slice does not require or
justify connecting to Production or changing any stored profile.

The subsequent coherent runtime containment slice must guard every session issuance/read,
backup entry, raw-to-legacy user projection, account/link writer, startup doctor linking
and last-usable-admin check together. Activation additionally requires full route/resource
and field projections, monotonic revocation, transactional authority commands and audit,
an explicitly verified immutable owner binding and a quarantine-compatible rollback.
An absent owner binding alone is not an activation guard: the existing pure canonical
resolver can return allowed access without an owner. Do not call it to authenticate this
adapter's canonical snapshots.

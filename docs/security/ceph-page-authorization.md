# Ceph page authorization regression evidence

Baseline: `a03aea1eb911c3c886028bc902f6f4f97f3546cf` (current main when this branch was created).

The baseline was built and exercised before editing application code. The test uses the real standalone production server and the existing HTTP harness, which creates and drops `aqlan_sec_http` on localhost. All patient names, diagnoses, landmarks and accounts are synthetic. No Production service, credential, financial file or migration was changed.

## Independently reproduced behavior

Both an unrelated doctor and the patient's own doctor with `canViewXrays: false` received:

| Request | Initial HTML | RSC (`RSC: 1`, `_rsc=`) |
| --- | --- | --- |
| `/ceph/<study>` | Patient, diagnosis and landmark sentinels leaked | Same three sentinels leaked |
| `/ceph/compare?first=<one>&second=<two>&patient=<owner>` | Patient sentinel leaked | Patient sentinel leaked |

The study and comparison API checks still returned 403 for the unrelated doctor. Those existing protections are not defects and remain unchanged.

HTTP regression file SHA-256 (identical red and green): `326f57c7f328ffd553b924df2dc31dce48cf75287631eca091c23f4a315b814f`.

The exact new HTTP regression file ran red on baseline: **16 failed, 2 passed**. Eight failures directly reproduce the permission leaks above. Six failures are the new expectation that an authorized comparison without the optional `patient` parameter derives the name from the studies (baseline showed no name); their preceding positive assertions for authorized workspace and comparison-with-patient succeeded. The other two failures detect patient-name serialization when a comparison study does not exist. These counts must not be interpreted as 16 independent security defects.

## Repair and policy boundaries

A small page-specific helper selects only the non-discarded study's patient ID, then invokes canonical `canAccessPatient(session, patientId, "canViewXrays")`. Clinical study data and patient names are read only after admission. The workspace additionally checks that the loaded study still belongs to the admitted patient before serialization.

The comparison authorizes both stored study owners, requires the same patient, and rejects a conflicting or invalid optional patient parameter. `first` and `second` remain distinct positive IDs; `a` and `b` are not aliases. Missing and discarded studies are rejected.

Reception remains allowed by the patient helper, as before. The comparison API's separate stricter role restriction remains unchanged; a positive reception page test does not claim reception can retrieve comparison API data. No role policy or API check was weakened. `lib/db.ts` and shared financial files are untouched.

## Reproducible checks

Use Node 22 and a disposable local PostgreSQL server with `TEST_DATABASE_URL` configured. The HTTP harness drops and recreates its named test database. Build before running HTTP tests.

```sh
npm run build
npm run test:security-http -- __tests__/security-http/ceph-page-authorization.test.ts __tests__/security-http/http-permission-matrix.test.ts __tests__/security-http/rbac.test.ts
npm test -- __tests__/ceph-page-access.test.ts __tests__/http-permissions.test.ts __tests__/ceph.test.ts __tests__/ceph-compare.test.ts __tests__/ceph-superimpose.test.ts
npm run typecheck
npm run lint
```

Candidate results: all **18 Ceph HTTP regressions passed**, **47 total HTTP tests passed**, and **71 unit/permissions/ceph tests passed**. Unit tests exercise actual page functions and verify no sensitive reader is called on denied, missing, failed-policy or failed-ownership requests, and verify admission precedes authorized reads. HTTP cases cover missing/invalid/discarded studies, same IDs, different stored patient identities and conflicting patient parameters in both response formats.

Explicit `npm run typecheck` passed. Repository-wide lint passed with **0 errors and 208 warnings**, none in the changed files.

Both baseline and candidate production builds succeeded with the same pre-existing Turbopack warning about dynamic filesystem access in `lib/migration-files.ts`. No deployment or merge was performed.

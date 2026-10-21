# Purchase generator Docker-context import repair

Base: `9e8fd301ebcdee1197b75bc6d182861ff35712b8`.
Source commit: `fc50eb3b94d6616a313e5496fe04ee58824d3fca`.

Docker excludes `__tests__`, but TypeScript includes `scripts/**/*.ts`.
The fixture generator imported the test-only `_safe-target` wrapper. That wrapper
(with no options) directly delegates to `validateOwnershipHarnessEnvironment`.
The generator now imports and invokes that same existing canonical function.
There is no new guard, fallback, target classification, or generator behavior.
Dockerfile, dockerignore, tsconfig, migrations and generated fixture are unchanged.

The regression walks TypeScript-configured non-test source imports (including
transitive local imports using TypeScript module resolution) and rejects any
edge into the Docker-excluded test tree. It runs in the ordinary unit suite.
It is a test-tree dependency boundary check, not a complete dockerignore parser
or replacement for image builds. Before repair it failed on exactly the generator.

## Reproduction and checks

Node22.23.3. Docker itself exported the filtered context with the repository's
unchanged dockerignore using a temporary `FROM scratch; COPY . /` Dockerfile
and local output. Absence of `__tests__` and node_modules was checked. The original
generator was placed in that context and tsc reproduced exactly TS2307 at (4,44).
After restoring the fixed source, local dependencies were copied into the
filtered context for the normal production build (no tests copied in).
An initial dependency symlink was rejected by Turbopack; a physical copy fixed
that local setup issue without changing build options.

- Before: new regression failed; filtered tsc reproduced TS2307.
- After: 139 focused unit/guard/provenance checks passed in four files.
- Full repository tsc and scoped ESLint passed (exit 0).
- Normal Next production build in Docker-exported context passed, including TypeScript.
- Operator preflight build/help and runtime braces absence verifier passed in
  that same context (7,549 shipped/provenance files, 343 traces).
- Real synthetic PG18.6, server_version_num180006: generator passed and fixture
  stayed byte-identical; all seven purchase-readiness PG tests passed.
- Fixture SHA256: `fa9a00517c31be3002c44439293b28b6fa23c944c5ed60ec2df62d54e95a0fe9`.
- Synthetic container: aqlan-purchase-import-pg18-synthetic, label
  aqlan.purpose=purchase-import-regression, loopback127.0.0.1:55444, ID
  5549b88a3d6c4681320d3d1973a5bf1ce5d54022fe5586738efb8583cce571d2.
  Target identity, PG version and empty public schema verified before generation.

## Image-build limitation

Actual unmodified Dockerfile image build was attempted. It failed before
TypeScript when Alpine APK DNS lookup failed during `apk add su-exec`.
No image success is claimed. The separate builder-stage attempt failed at npm ci with npm reporting
"Exit handler never called!"; its cause is not established as DNS. Neither
container attempt reached Next compilation. The successful local filtered-context
build used the already installed lockfile dependencies, not a successful image install.
No Railway configuration, secrets, production data, deployment or merge action.
Parent owns review and integration after gates pass.

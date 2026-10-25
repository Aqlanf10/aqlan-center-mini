# Independent reviewed finance composition

Base: frozen #439 `9881d33c21c4812ae3e18219a8112438d6192a78`. Four parent-preserving merges include only #442 `a56ace6028845b41d821f21c3c357970632f4f8a`, #444 `45067c5315937982198ce0e4f4097aa22f1f58f8`, #445 `10a4920361ccb926fb984271a1680ca582eca5e5`, and #446 `48cf8251737d6b150b7ce4b63bd8b25be7391830` beyond that base. Remote PR heads were checked before use. #443 and #447 are explicitly excluded.

There are no overlapping changed paths among the four additions, no manual conflict resolutions and no duplicated cherry-picks. `source-accounting.json` records each source's exact final blob for every changed path; all match the composed tree. Authorship and source ancestry are preserved. No migration or published migration checksum changes.

The sole workflow change adds this exact independent branch to the existing finance-image allowlist. Repository/same-repository/main-base checks, read-only permission, exact-head checkout, no credentials persistence, unchanged Dockerfile and offline non-root artifact verification remain intact. Image testing publishes no image and starts no application.

The RR read-only statement snapshot, batch-local repayment cache, fail-closed advisory/runtime checks and two-label-only font scope are source-identical to the reviewed heads. Historical source evidence remains labelled with its original head; it is not proof of this composition. Local and hosted fresh results will be reported separately on the Draft PR, with skipped gates explicitly unproven.

Production database compatibility and recovery evidence remain blockers. This branch does not authorize merge or deployment. No Railway, real data, secrets, Production settings or backup operations are part of this verification.

# Completed-work finance composition (release-handoff candidate)

**Base:** reviewed composition #448 `5f18f26709d068b24fbdc4c5c3bde3eed8e3ac62`, itself built on frozen #439 `9881d33c`. It contains:
- #442 `a56ace60`;
- #444 `45067c53`;
- #445 `10a49203`;
- #446 `48cf8251`.

**Added, and only these:**
1. **#447 `e91fbe923fb92d3026caf34b892a9a41cb384617`**, the historical treatment details in the current printed statement, by one parent-preserving merge.
2. **#450's Zod lock repair `96bb3e2e132cc0fac677d2402abc58e302f3241b`**, by `cherry-pick -x` with its provenance retained.
   - It addresses GHSA-mrhx-c7xc-m3w5, upgrading the dev Zod node from 4.6.3 to 4.6.6.
   - Only three `package-lock.json` fields change; there are no manifest, override, audit-policy or CI-gate changes.
   - Nothing else from #449 or #450 is imported.
3. **Workflow:** this exact branch is added to the existing finance-image allow-list. The same, single kind of change was made in #448. All repository, base and permission guards, the exact-head checkout, the unchanged Dockerfile and the offline non-root artifact checks remain intact. No image is published.

**Conflict resolutions (explicit; the only two):**

`lib/db.ts` `patientStatementSnapshot` keeps from #444:
- the derived `planCurrencies` map;
- `hydratePlans(rows,today,client,true)`;
- the snapshot-local repayment cache.

It adds only #447's `options` parameter and the opt-in `readStatementHistoricalAgreements(client, patientId)` on the same RR client. `lib/plan-financial-position.ts` is untouched.

`app/print/statement/[id]/page.tsx` keeps #446's `labels.module.css` import, its two scoped label rows and its font, and adds #447's historical presentation import.

**Source accounting:**
- Every #447-changed path equals its #447 blob, except the two resolved files above.
- Every #448-changed path equals its #448 blob, except the same two files.
- `package-lock.json` equals 96bb3e2e's result.

**Migrations:** none are added by this composition beyond those already in #439/#448. The candidate's migrations over `main` `2667b71f` are 0066–0069, and published checksums are unchanged.

**Not authorised by this branch:** merge, deployment, Production migration, Railway, real data, secrets or backups. Production database compatibility, recovery proof and migration locking remain unresolved release gates.

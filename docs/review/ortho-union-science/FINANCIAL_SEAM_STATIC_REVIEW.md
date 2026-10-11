# Invoice-first Ortho clinical/financial handoff review

Reviewed 2026-10-11, 22:39–22:44 UTC. Static inspection only. No application, test, SQL, build, branch, commit, deployment, or implementation edits were performed. Source snapshots and this review are the only new artifacts.

## Scope and source identity

- Frozen financial source: `2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9`, tree `880030f12d6fc718fcf98720327f9ba8969478b8`.
- Ortho independent source and unapplied shared proposals: PR324 `476f374b33e996bcf2909cbdb9449d25fffcc6c0`.
- Main comparison: `148fcbeac229cb279848e6ea37049d1599a4fafe`; financial donor base: HR `8ff09304ef3fbf8f01f04a1f09de2a08f6c403c5`.
- Most references below are exact frozen2eda files fetched with the GitHub connector. `SOURCE_MANIFEST.json` records returned Git blobs and canonical source URLs. DB content was read from the b2cd source donor after exact2eda returned the same Git blob, `6a5899a2b8fdf38a9ec5f942eb861ae789c9084b`. PR324 sources/proposals are under `/workspace/shared/ortho-shared-review-476f374b`.
- The primary Ortho task is actively composing newer source. The cross-version findings below are integration gates, not assertions that its current code has these bugs. No runtime acceptance is claimed.

## Prioritized findings

### P1 — Assessment bridges need an explicit financial-entry policy

Frozen `lib/invoice-linkage-db.ts:496–529` accepts and auto-selects only bridges with an Ortho case in `active` or `retention`. Frozen `lib/legacy-treatment-db.ts:288–317` has the same restriction. PR324 `lib/ortho-assessment-lifecycle-store.ts:148–165` deliberately reuses an existing invoice/legacy shell and attaches a new `assessment` case, or creates a waiting bridge with unknown site.

These predicates are incompatible if composed unchanged: selecting the assessment bridge explicitly is rejected; omitting it excludes that bridge from the candidate set and can permit a new unbridged shell for fresh work. This does not imply every subsequent request duplicates: existing-work/legacy-lineage guards can reject earlier, which is also why both paths must be tested.

Required decision: the final financial preview and writer must either safely reuse the exact assessment episode with adequate scope evidence, or return a clear blocking decision. Do not broaden active treatment admission, manufacture an arch, silently select a different episode, or create a second shell as a fallback. Cover both financial writers, their previews and their retry receipts.

### P1 — Existing Ortho continuity evidence does not cover the new mounted journey or second-visit signing

Frozen `__tests__/security-http/invoice-clinic-continuity-journey.test.ts:354–371` creates the Ortho case through old `POST /api/ortho`, signs the first visit, and schedules the next. It does not arrive at and sign that second visit. `:219–248` stages a linked planned-item procedure in Today; it does not exercise PatientOrtho's adjustment/save/sign-card path. The double-sign assertions at `:250–270` are useful and should be retained.

The distinction matters: `lib/db.ts:17500–17514` classifies linked procedures, whereas `:16307–16346` classifies Ortho adjustments using installment/legacy evidence, and `:17542–17565` joins adjustment writing to signing. A case's `planId` is a reference, not proof that every action is included. `lib/treatment-financial-context.ts:123–162` deliberately marks package coverage unspecified and plan value as non-debt.

Run final mounted invoice → intake → assessment → activation → consent → first visit → second visit, including the adjustment/sign-card entry. Assert no duplicate invoice and no duplicated clinical session. Where coverage is genuinely unknown, retain the explicit review/decision fence rather than weakening it to make the journey pass.

### P1 — Preserve the unified financial CTA and owner guards when composing PatientOrtho

Frozen `components/PatientOrtho.tsx:367–405` declares and forwards `onOpenTreatmentEntry`, including its standalone `canLeave()` fallback. `:613–615` presents the sole financial-entry CTA. The parent page routes it through all active leave guards at `app/patients/[id]/page.tsx:259–273,318–324`; `app/api/plans/route.ts:112–119` refuses direct new plan creation.

PR324 proposal `components/PatientOrtho.tsx.patch:298–303` replaces the provider/workspace seam without forwarding that callback. Its agreement step relocates the financial context at patch `:734–747`. This is already identified by the shared contract at `SHARED_INTEGRATION_CONTRACT.md:59–64`; it needs an explicit combined acceptance test, not only a conflict-free text merge.

Keep case/intake forms clinical-only, preserve existing plans/cases, and route both fresh invoice and pre-system agreement creation to the same account entry. Test dirty draft, in-flight write, uncertain outcome, denied read, Back/Forward, patient switch and role loss. No rejected navigation may open a second financial editor or consume the entry request.

### P2 — The retained package-card CTA still sends users to the old creation destination

Exact frozen `components/OrthoPackageLink.tsx:198–201` says to create an Ortho agreement from Plans and uses a raw `/patients/{id}?tab=plans` anchor. Frozen `components/PatientPlans.tsx:251–259` now tells the user to go to the unified account flow instead. The package component is unchanged from main, so this is inherited integration debt rather than a new PR324 defect.

At minimum, make the copy and destination agree with the sole financial entry and preserve selected-case identity/leave guards. `lib/patient-navigation.ts:125–143` controls popstate and programmatic navigation; this raw link does not call that controller. Browser unload protection is not equivalent to the parent-owned navigation contract, and the proposed in-memory recovery has its own hard-reload limits. Verify using the actual mounted UI before calling this resolved. Apply this correction only in the cohesive Ortho integration; do not change the frozen invoice candidate for this P2 item.

## Concrete cross-module acceptance tests for the developer

1. **Fresh invoice → existing shell → assessment → activation.** Create one invoice with one Ortho item. Record exact invoice/plan/item/clinical-case IDs. Open assessment using that shell, activate using the intended existing plan, then reload and navigate from account to the exact case. Assert those IDs/provenance survive, exactly one Ortho case exists, no extra invoice/payment/opening appears, and invoice entry never supplies clinical consent or treatment-start facts. Retrying each successful command returns the same identity.
2. **Assessment before financial entry.** Start a clinical-only assessment, including unknown arch/site. Try invoice preview/save and legacy preview/save with explicit bridge and omitted bridge. Require coherent explicit reuse or a clear non-writing refusal; never a second shell, inferred scope or alternative patient/case. Repeat after scope is explicitly documented and after assessment cancellation. Include simultaneous intake/financial requests against the same patient.
3. **Legacy Ortho 300000/120000 → 180000 opening only.** Use an Ortho service and explicit arch, not the existing bridge14–16 fixture. Record 300000 agreed and 120000 paid before the system. Assert one 180000 native-currency opening principal, no invoice, no receipt for historical payment, no cash/shift movement, no fabricated consent and no implicit future sessions. Reuse the case through assessment/activation; debt must remain 180000 until an authorized actual collection. Retry/lost-response recovery must not increment it. Frozen reference: legacy UI `:105–127`, writer `lib/legacy-treatment-db.ts:258–279,412–442,490–510`.
4. **Existing plan/case preservation.** Reuse one compatible unpaid item and its clinical case. Assert no replacement plan/item/case and unchanged clinical schedule, consent, history and original provenance. Test multiple candidate plans/cases (explicit choice required), already-invoiced work, legacy-covered work, cancelled plan, wrong-patient IDs and incompatible debt currency (all non-writing refusals). Frozen reference: `lib/invoice-linkage-db.ts:100–158,192–208,354–358,412–427,496–503`.
5. **Second visit signing, both clinical entry paths.** After first signed visit and real collection, arrive for the next planned visit; record through Today and separately exercise the Ortho adjustment/sign-card path. Sign twice concurrently and retry after losing the response. Assert exactly one completed clinical session/adjustment for the intended visit; no additional invoice or invoice line for already covered work; no extra receipt, debt or collection; next appointment uses the current pending session. Separately test cancelled financial source and scope mismatch, preserving refusal/review behavior.
6. **Same patient and debt-currency boundaries.** Send another patient's plan/item/case/invoice IDs in preview, write, activation and navigation. Require refusal with zero mutation and no foreign financial display. Mix YER/SAR/USD and assert account positions stay currency-separated. A clinical plan total is not new debt; a patient's opening balance is not a per-case allocation. Frozen references: `lib/treatment-financial-context-db.ts:41–89`, projector `:63–79,124–175`, component `components/TreatmentFinancialContext.tsx:55–81`.
7. **Case navigation and role changes.** Account → precise plan/item/case → Ortho agreement step → Back/Forward. Supply inconsistent same-patient IDs and verify fail-closed behavior, without widening to all cases. Simulate A → B → A, old response arriving late, permission loss/regrant and doctor-assignment loss. No prior patient money or command may reappear. Frozen references: `components/TreatmentFinancialContext.tsx:43–81`, `components/useClinicalNavigationContext.ts:7–26`, `lib/patient-navigation.ts:168–187`.
8. **Financial ownership and rollback.** Assert clinical-only assessment/study/activation/retention commands never POST `/api/plans` or invoke financial creation; direct new `/api/plans` POST remains409 for otherwise-authorized users. Existing plan/case updates remain available. Inject audit failure into financial and clinical commits in an isolated fixture and verify each transaction rolls back completely. Preserve `itemsFor/getInvoice`'s supplied transaction client so idempotent financial readback cannot escape the committed/locked identity.

## Invoice-only extraction boundary

The 56-file financial manifest targets HR8ff (`verified-b2cd-integration/MANIFEST.json`), not main148fc. A mechanical copy onto main is not a proven minimal extraction.

Exact main reads establish:

- `components/TreatmentFinancialContext.tsx`, `lib/treatment-financial-context.ts` and `lib/treatment-financial-context-db.ts` are absent. Final2eda imports them. The closure also includes its validator, the patient financial-context HTTP route and the current route-permission contract.
- Final patient navigation imports `components/useClinicalNavigationContext.ts` and depends on `/api/patients/{id}/clinical-context`, strict patient-navigation decoding and Ortho pillar navigation. Include an explicitly reviewed narrow prerequisite slice or adapt to main's existing contract; do not silently delete identity checks.
- `lib/legacy-treatment-db.ts` is already byte-identical by Git blob between main and2eda (`3185027f…`). `components/OrthoPackageLink.tsx` likewise (`1ec19b90…`). They do not justify importing the entire HR/clinical base.
- Preserve the narrow DB reader seam (`itemsFor`/`getInvoice`, approximately8974/9125 in matching b2cd source). Never replace all of `lib/db.ts`, `PatientOrtho.tsx`, migration registries, permissions or session/layout files from a mixed branch merely to satisfy imports.
- PR324 assessment activation is a separate clinical slice with route/schema/session dependencies. It must not be smuggled into an invoice-only extraction, and its independently passing CI does not validate those unpublished companions.

The parallel feasibility reviewer owns the full exact-tree prerequisite matrix. This report identifies concrete dependencies and behavioral gates, not an approved cherry-pick list or release recommendation.


## Exact-source provenance manifest

{
  "review": "Read-only static integration review; no application, tests, SQL, build, branch, commit, or implementation edits",
  "head": "2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9",
  "pr324Head": "476f374b33e996bcf2909cbdb9449d25fffcc6c0",
  "main": "148fcbeac229cb279848e6ea37049d1599a4fafe",
  "fetchedSources": [
    {
      "path": "components/PatientOrtho.tsx",
      "gitBlob": "7f6adb8889b552a1f1e0b106fc4d921809f9da98",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/components/PatientOrtho.tsx"
    },
    {
      "path": "components/TreatmentFinancialContext.tsx",
      "gitBlob": "fe692088a93d650e08dbed716a5d621b9aa1bd33",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/components/TreatmentFinancialContext.tsx"
    },
    {
      "path": "components/OrthoPackageLink.tsx",
      "gitBlob": "1ec19b9055a2695e7788b3f80d53ec38c115fc9e",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/components/OrthoPackageLink.tsx"
    },
    {
      "path": "lib/invoice-linkage-db.ts",
      "gitBlob": "401a03a7145fb969e52ce91bf894e1fbf09babe4",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/lib/invoice-linkage-db.ts"
    },
    {
      "path": "lib/treatment-financial-context-db.ts",
      "gitBlob": "d8e352255ab30d0b1b5ae7f433a483bca0a88b26",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/lib/treatment-financial-context-db.ts"
    },
    {
      "path": "lib/treatment-financial-context.ts",
      "gitBlob": "90a0dc84ca87149be796e1a80d9e3ed76f803fb0",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/lib/treatment-financial-context.ts"
    },
    {
      "path": "components/TreatmentEntryChoice.tsx",
      "gitBlob": "5c8a3596b560cce4518f116807a12d344e1e3641",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/components/TreatmentEntryChoice.tsx"
    },
    {
      "path": "app/api/plans/route.ts",
      "gitBlob": "40bdc224a3fd66711016a499cfe955acf42d7761",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/app/api/plans/route.ts"
    },
    {
      "path": "app/patients/[id]/page.tsx",
      "gitBlob": "e3e53ccda45a906a072a52e80d732237f40f929e",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/app/patients/[id]/page.tsx"
    },
    {
      "path": "lib/legacy-treatment-db.ts",
      "gitBlob": "3185027f71fa436570ceef5376dab8c217dd65ff",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/lib/legacy-treatment-db.ts"
    },
    {
      "path": "__tests__/security-http/invoice-clinic-continuity-journey.test.ts",
      "gitBlob": "70c15215628af674035956317bb5316645cb5bec",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/__tests__/security-http/invoice-clinic-continuity-journey.test.ts"
    },
    {
      "path": "__tests__/security-http/legacy-treatment-ui-journey.test.ts",
      "gitBlob": "2ec14e213face150ac2d086e075801f8a6a73a6f",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/__tests__/security-http/legacy-treatment-ui-journey.test.ts"
    },
    {
      "path": "components/PatientPlans.tsx",
      "gitBlob": "2e0c4ef1e106d361c81d4c40eecd6feeb8f8556b",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/components/PatientPlans.tsx"
    },
    {
      "path": "lib/patient-navigation.ts",
      "gitBlob": "6118707cc56d742297bcef2e1b09404ed59cfe83",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/lib/patient-navigation.ts"
    },
    {
      "path": "app/api/ortho/[id]/route.ts",
      "gitBlob": "69710716693f835e744328b67151c2b2570da21e",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/app/api/ortho/[id]/route.ts"
    },
    {
      "path": "components/useClinicalNavigationContext.ts",
      "gitBlob": "b5047cf28502aa4633a2f01f863dd5318038d5fa",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/components/useClinicalNavigationContext.ts"
    },
    {
      "path": "lib/treatment-financial-context-validation.ts",
      "gitBlob": "a39b306d1b2fd268cf54b1ca856db9460008d992",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/lib/treatment-financial-context-validation.ts"
    },
    {
      "path": "app/api/patients/[id]/treatment-financial-context/route.ts",
      "gitBlob": "63f455702dd802ceb7003a244e15ad037d345904",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/app/api/patients/[id]/treatment-financial-context/route.ts"
    },
    {
      "path": "lib/invoice-clinical-linkage.ts",
      "gitBlob": "cb646d1eaf0284e8f70b7bcdb9817785c288936d",
      "url": "https://github.com/Aqlanf10/aqlan-center-mini/blob/2eda4f5bcec6d604ec6a4156d04b4d87ec388ac9/lib/invoice-clinical-linkage.ts"
    }
  ],
  "db": {
    "gitBlob": "6a5899a2b8fdf38a9ec5f942eb861ae789c9084b",
    "note": "Exact-head GitHub fetch returned blob metadata but empty content for large file. Read line references from matching verified-b2cd source donor.",
    "source": "/workspace/shared/recovery-20261011-0105/unified-invoice-agreement-integration-8ff/verified-b2cd-integration/overlay/lib/db.ts"
  },
  "mainComparisons": [
    {
      "path": "components/TreatmentFinancialContext.tsx",
      "error": "GitHub API error 404: {\"message\":\"Not Found\",\"documentation_url\":\"https://docs.github.com/rest/repos/contents#get-repository-content\",\"status\":\"404\"}"
    },
    {
      "path": "lib/treatment-financial-context-db.ts",
      "error": "GitHub API error 404: {\"message\":\"Not Found\",\"documentation_url\":\"https://docs.github.com/rest/repos/contents#get-repository-content\",\"status\":\"404\"}"
    },
    {
      "path": "lib/treatment-financial-context.ts",
      "error": "GitHub API error 404: {\"message\":\"Not Found\",\"documentation_url\":\"https://docs.github.com/rest/repos/contents#get-repository-content\",\"status\":\"404\"}"
    },
    {
      "path": "lib/legacy-treatment-db.ts",
      "sha": "3185027f71fa436570ceef5376dab8c217dd65ff"
    },
    {
      "path": "lib/invoice-linkage-db.ts",
      "sha": "bbf5c7989c9eca54fd7881b4406a527bc1897ebc"
    },
    {
      "path": "lib/patient-clinical-navigation.ts",
      "error": "GitHub API error 404: {\"message\":\"Not Found\",\"documentation_url\":\"https://docs.github.com/rest/repos/contents#get-repository-content\",\"status\":\"404\"}"
    },
    {
      "path": "lib/invoice-clinical-linkage.ts",
      "sha": "3623ce1ad302f60e4fcd712d7cc4969859da8923"
    },
    {
      "path": "lib/invoice-explicit-selection.ts",
      "error": "GitHub API error 404: {\"message\":\"Not Found\",\"documentation_url\":\"https://docs.github.com/rest/repos/contents#get-repository-content\",\"status\":\"404\"}"
    },
    {
      "path": "components/OrthoPackageLink.tsx",
      "sha": "1ec19b9055a2695e7788b3f80d53ec38c115fc9e"
    },
    {
      "path": "lib/db.ts",
      "sha": "5c22307f37e73c03628b4f29aadee9d3eb933311"
    }
  ]
}

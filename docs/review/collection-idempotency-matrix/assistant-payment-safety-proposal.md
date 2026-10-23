# Proposal: a narrow safety fix for the EXISTING assistant payment writer (not implemented)

- **Status:** proposal only, per Dot's comment on #440. No product code is changed on this branch.
- **Implementation:** waits for the independent source findings and an explicit go-ahead.
- **Out of scope:**
  - any new agent capability or widened permission;
  - any automatic payment policy;
  - any Production setting;
  - any change to frozen #429.
- **Not attributed:** this gap is NOT attributed to the historical live duplicate incident. There is no evidence linking them.
- **Evidence:** all evidence is synthetic and local:
  - `assistant-payment-tool-repro.json`;
  - `assistant-payment-red-before.json`.

## 1. Reachability: what exists today (source facts)

### Path to a real receipt

| Step | Code | Gate today |
|---|---|---|
| Chat request | `POST /api/ai/chat` (`app/api/ai/chat/route.ts`) | Session required, user active (DB reload), `canUseAiChat(role, permissions)`, `ai_settings.enabled` (line 134), prompt-injection scan of the whole history |
| Payment intent | `lib/assistant-engine.ts` ~l.466, a **local regex engine** (`model: "aqlan-action-engine"`) | **No external AI credentials are needed.** The intent is parsed locally, then `executeAiTool("record_patient_payment", {patientName, amount, currency, method})` runs |
| Offer (preview) | `lib/ai-tools/registry.ts` ~l.398 (offer path) | Policy `record_patient_payment` (`lib/ai-tools/policy.ts:258`): see "Policy fields" below. Patient scoping is resolved, then the preview is HMAC-signed with a 10-minute TTL (`lib/ai-confirmation.ts:23`) |
| Confirm | `POST /api/ai/confirmation` → `executeAiTool(..., {confirmationToken})` | Signature, TTL, same user, tool match, user active (DB reload), `canUseAiChat`, patient re-scoped on current data. Then `claimToolConfirmation(jti)` (`lib/db.ts:15026`) commits **its own** insert before execution (registry ~l.381) |
| Write | `recordPatientPaymentAction` (`lib/ai-tools/action-tools.ts:577`) → `recordPayment({...})` | `canHandleMoney(role)`, positive amount, `isDbConnected`. The writer's own guards apply: open shift, target ownership, currency rules, receipt audit in the same transaction |

Policy fields for `record_patient_payment`:
- `access: stateChanging`
- `allowedRoles: ["admin","reception"]`
- `financeScope: "handle_patient_payment"`
- `requiresConfirmation: true`
- `patientScoped: true`

### Defaults (as code ships them)

- **`ai_settings.enabled`:**
  - The table default is `FALSE`.
  - However, the seed in `ensureSchema` (`lib/db.ts` ~l.2154) inserts `enabled = TRUE`, and `getAiSettings()` falls back to `enabled: true` (`lib/ai.ts:75`).
  - The synthetic run confirms `enabled: true`, `has_key: false`.
  - **A missing AI key does not disable this path.**
  - The comment above `getAiSettings` says a missing row means the service is disabled until the owner configures it. This contradicts `DEFAULTS.enabled = true`. The discrepancy is reported for the source review and is not changed here.
- **`canUseAiChat`:**
  - admin: always;
  - doctor: on by default, but the tool policy refuses doctors;
  - reception: off unless the per-user permission enables it;
  - cashier: not in `allowedRoles`.
- **`isDbConnected`:** false only for CI placeholder URLs (`ci:ci@`, `…/aqlan_center_ci`, `ci-placeholder`). This is why **no hosted CI run ever reaches the database through this path**. In production it is true.

### What the writer call lacks, compared with every other human collection door

- **No retry identity:** no `idempotencyKey` is passed.
- **Replay:** the only replay barrier is the token claim. It is committed separately and **before** the receipt transaction.
- **No similar-collection review:** no `similarityReview` is passed, so `assertSimilarCollectionReviewed` is skipped (`review === undefined`).
- **FX handling differs from the HTTP door:** it uses `recordPayment` with a raw settings rate, not the HTTP door's settings-owned adapter (`recordSettingsOwnedPayment`).

### Red-before evidence

Synthetic, local, against the central executor: `assistant-payment-red-before.json`.

| Row | Today |
|---|---|
| R1 | The same confirmation retried after its receipt committed (lost reply) is refused: «رمز التأكيد مستهلك…». There is no duplicate, but the operator never learns that it succeeded, and the error invites a fresh request. |
| R2 | A second preview, taken before the first receipt committed and then confirmed, records a **second identical receipt** (`idempotency_key: null`). |
| R3 | A preview taken after two equal receipts exist shows **no** similar receipts. |
| R4 | Two tokens confirmed concurrently record **two** receipts. |

## 2. Proposed change (narrow; four edits, no new capability)

Every existing gate stays exactly as it is:
- chat and confirmation session reload;
- `canUseAiChat`;
- `allowedRoles`;
- `canHandleMoney`;
- signature, TTL and same-user checks;
- patient re-scoping;
- the claim;
- `ai_settings.enabled`;
- the writer's shift, target and currency guards.

### A. Durable retry identity

In `recordPatientPaymentAction`, pass `idempotencyKey: "ai-confirm:" + payload.jti`:
- The jti comes from the verified, signed token.
- The key is at most 47 characters and matches `IDEMPOTENCY_KEY_PATTERN`.
- The jti reaches the action through the verified context only (a new field on the executor's internal call), **never** from params or user text.

### B. Replay instead of refusal on a claimed token

This applies to this tool only. In the executor, when `claimToolConfirmation` returns false:
- Look up `getPaymentByIdempotencyKey("ai-confirm:" + jti)`.
- If it exists **and** `createdBy === context.username` **and** `patientId` equals the re-scoped patient, return that receipt as a replay: «سُجّل هذا السند سابقًا: R-…». This writes nothing new.
- Otherwise keep today's refusal.

The claim, and the order of the claim relative to the write, are unchanged.

### C. Canonical similar-collection review in the signed preview

In the offer path for this tool, after patient scoping:
1. Call `findSimilarCollectionsOn(pool, patientId, amountMinor, currency)`.
2. Write the reported ids into the signed params as `similarObservedReceiptIds`, **overwriting** anything supplied by the engine or user text.
3. Show each receipt as a sensitive preview field: «سند مشابه خلال 24 ساعة: R-… — المبلغ — التاريخ».

At execution, pass `similarityReview: { observedReceiptIds: params.similarObservedReceiptIds ?? [] }` to the writer.

- **What the writer does with it:** the writer's existing in-transaction check runs after the shift lock and the exact-key replay. So:
  - a stale preview (R2) or a concurrent second confirmation (R4) is refused with the canonical Arabic review message and writes nothing;
  - a preview that disclosed the similar receipt and was confirmed records an independent receipt, which is existing policy.
- **On a refusal:**
  - The tool returns the canonical message. The token is already claimed, so the operator must request a new preview, which now discloses the receipt. No automatic retry happens.
  - **Nothing in this flow ever creates or cancels a payment automatically.**

### D. Same FX semantics as the HTTP door

Call `recordSettingsOwnedPayment` instead of `recordPayment` for this tool. It is the adapter the ordinary HTTP door uses: settings-owned rate, the same refusal for a missing rate, and a replay that survives a later rate change. This is optional; if the source review prefers minimal surface, keep `recordPayment` and accept that a replay after a rate change returns `idempotency_conflict`.

### Not changed

- No new tool, alias, role, permission, flag or default.
- No automatic collection, cancellation or deduplication.
- No change to `ai_settings` defaults. Disabling or changing them is an owner decision, outside this fix.
- No change to the payments route, the writer, the similar-collection helper or any migration.

## 3. Acceptance matrix (red-before → green-after)

**Where the tests run:** real PostgreSQL 18 with synthetic data, calling the central executor and the confirmation route handler directly. The chat and confirmation routes treat CI URLs as offline, so the PG test must exercise `executeAiTool` with `isDbConnected: true`. This is the same function the route calls, and every gate lives there.

**How "no writes" is checked:** the whole-database content hash from `collection-entrypoint-idempotency-matrix.test.ts`.

| # | Case | Today (red-before) | After |
|---|---|---|---|
| R1 | Same token retried after its receipt committed | Refused with an error; the receipt is not returned (red) | Replay of the same receipt id; no writes |
| R2 | Two previews from the same state, both confirmed | Two identical receipts (red) | Second refused with `similar_collection_review_required`; no writes |
| R3 | Preview after an equal receipt exists | No disclosure (red) | Preview lists the receipt(s) with number, amount and date |
| R4 | Two tokens confirmed concurrently | Two receipts (red) | One receipt; the other refused for review; no writes from it |
| R5 | Disclosed preview confirmed | n/a | Independent receipt recorded; both keys replay their own receipt |
| R6 | `similarObservedReceiptIds` or `idempotencyKey` injected via user text or engine params | n/a | Ignored; server-computed values only |
| R7 | Tampered token, expired token, other user's token, inactive user | Refused (green) | Unchanged (green) |
| R8 | doctor; reception without `canUseAiChat`; cashier; `ai_settings.enabled=false` | Refused (green) | Unchanged (green) |
| R9 | Patient re-scoped to another doctor after preview; patient changed | Refused (green) | Unchanged (green) |
| R10 | No open shift | Token claimed, no receipt (green) | Unchanged; no key consumed |
| R11 | YER, SAR and USD on an invoice target; foreign currency without a target | Writer rules apply; foreign without a target refused | Unchanged; each currency separately |
| R12 | Audit | One receipt audit plus `ai.confirmation.execute` | Unchanged for new receipts; a replay adds no receipt audit |
| R13 | Other collection doors | 87-case matrix green | Still green (no shared code changed) |

### Red-before procedure

1. Commit R1–R4 as tests first. They fail on the current head, and the log is captured.
2. Then apply A–C (and D if chosen).
3. Show the full matrix green.
4. Run the full CI on the exact head.

## 4. Decisions needed from the owner and Dot before implementation

1. Go-ahead for A–C, and D yes or no.
2. Whether the assistant payment path should stay enabled by default in its current seeded state. This is a separate, owner-only decision about settings; this fix does not change it.

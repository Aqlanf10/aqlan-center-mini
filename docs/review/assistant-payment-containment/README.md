# CORE-SAFETY containment: assistant `record_patient_payment` execution

- **Approved by:** Dot's independent source finding on #440.
- **Base:** `integration/finance-candidate-20261022` @ `db5e97c04e2d8c0927d26c27024796974dfc2e6a` (#429, frozen; this branch is separate).
- **Not touched:** #438, #439 and #440.

## Why

The assistant payment action called `recordPayment` with neither an `idempotencyKey` nor a `similarityReview`. In addition, the confirmation claim is committed **before** the financial writer. As a result:
- a same-token retry cannot recover its receipt;
- a fresh-token request bypasses the canonical similar-collection review.

The path is reachable today:
- the local action engine needs no external AI key;
- `ai_settings` is seeded enabled.

Synthetic evidence is on #440 (`docs/review/collection-idempotency-matrix/`). It shows the mechanism only, not a live incident.

## Change (containment only)

| File | Change |
|---|---|
| `lib/ai-tools/contained-tools.ts` (new) | `CONTAINED_ASSISTANT_TOOLS = {record_patient_payment}`, plus one Arabic refusal that names nothing written and nothing consumed, with a link to the guarded collection screen (`/finance`) |
| `lib/ai-tools/registry.ts` | Two checks in the central executor. **Offer path:** refuse before any signed offer is built. **Token path:** refuse after the existing signature, tool, user and expiry checks and **before** re-scoping and `claimToolConfirmation`, so a previously issued valid token is refused and never consumed |
| `lib/ai-tools/action-tools.ts` | Defensive backstop: `recordPatientPaymentAction` returns the same refusal for any caller. This includes its former demo-mode branch, which claimed «[وضع تجريبي] تم تسجيل سند القبض». The writer call and its now-unused imports are removed |

**Not changed:**
- the tool's registration, aliases and policy;
- roles and permissions, and `canUseAiChat`;
- `ai_settings` and its seeds;
- signature, TTL and claim logic;
- every other assistant tool;
- the payments routes and writers;
- migrations, flags and financial arithmetic.

The existing guarded collection UI is untouched and is covered by a test.

## Gate order after the change (unchanged gates first)

1. Policy resolution. Aliases (`record_payment`, `receive_payment`, `record_receipt`) resolve to the canonical name.
2. `authorizeToolPolicy`: role and permission. A doctor is still refused as «غير مصرح».
3. **With a token:** a bad signature, a token for another tool or user, or an expired token keeps its existing refusal. Then the **containment refusal**. No re-scope, no claim, no writer.
4. **Without a token:** the **containment refusal** comes before any offer is built. No signed offer and no pending confirmation.
5. The confirmation route keeps its existing session, user-reload and permission gates. It records its usual `ai.confirmation.execute` audit line with `executed:false`.

## Tests

The new file is `__tests__/postgres/assistant-payment-containment.test.ts`: 12 cases on real PostgreSQL 18 with synthetic data. "Nothing written" is a whole-database content hash. The permitted exceptions are the confirmation route's `ai.confirmation.execute` audit line and the chat route's request-rate row, `login_limits`.

| Case | Assertion |
|---|---|
| Direct action, real DB and demo mode | Refusal; no «وضع تجريبي» success; no writes |
| Normal dispatch through the local engine (`processAssistantQuery`) | Intent `action_record_payment`; no confirmation; refusal plus `/finance`; no claim; no writes |
| Fresh request: canonical name and 3 aliases × admin and reception | No signed offer; no pending confirmation; no claim; no writes |
| Previously issued valid token × admin and reception, 3 sequential and 2 concurrent replays | Refusal; token **not consumed**; no writes |
| Tampered, unsigned, expired, other user's, doctor, doctor with token | Existing messages («غير صالح», «مستخدم آخر», «غير مصرح»); no claim; no writes |
| `POST /api/ai/chat` | No offer; refusal answer; no claim; no money tables moved. This runs in this environment's demo-mode short-circuit (CI URLs) |
| `POST /api/ai/confirmation` with an issued token, twice | `ok:false` and the refusal; no claim; no writes; audit lines `executed:false`. A reception user without the assistant permission still gets 403 |
| Another assistant tool (`add_patient_medical_alert`) | Still issues its signed offer (the containment is narrow) |
| Guarded collection door `POST /api/payments` | Doctor 403; missing key 400; admin 201; same key replays 200 with the same receipt |

**Red-before:** `red-before-fix.log`, on base `db5e97c0` with this test file only. 9/12 fail for the expected reasons:
- the action returned `success:true` and wrote a receipt;
- offers were issued for the canonical name and every alias;
- the issued token executed;
- the confirmation route returned the demo-mode success and consumed the token.

The 3 controls pass.

**Green-after:** 12/12.

### Existing tests adapted (no assertion weakened)

- **`__tests__/ai-confirmation-security.test.ts`:**
  - **Payment tamper and reauthorization cases:** six cases obtained their token from the payment offer, which no longer exists. They now use `issuedPaymentToken`, a token signed exactly as that offer signed one, which is the "previously issued" case. Every assertion is unchanged: the signature check rejects the token, the message is «غير صالح» or «غير مصرح», `recordPayment` is not called, and `claimToolConfirmation` is not called.
  - **Preview case:** the sensitive-field preview case now calls the unchanged `buildConfirmationPreview` directly. It additionally asserts that the executor issues no offer and claims nothing.
- **`__tests__/postgres/payment-audit-replay-repro.test.ts`:** "the existing alternate adapter emits exactly one canonical receipt event" encoded the old behaviour. It now asserts that the contained adapter writes no receipt and no audit row. This is the intended behaviour change.

### Other local evidence

- Full unit suite: 662/662 files, 11,578 tests.
- `tsc --noEmit` is clean. `npm run lint` reports 0 errors; its warnings already existed, and this change removes four.
- `npm run build` succeeds.
- Built-app HTTP: `bodies`, `rbac` and `ai-fallback` pass 44/44.
- PostgreSQL: the new file and `payment-audit-replay-repro` pass 25/25.

## Honest gaps

- **No restore path:** restoring an assistant payment capability requires the guarded design in #440's proposal (A–C). Nothing here restores it.
- **Production not inspected:** current Production `ai_settings` and usage were not inspected, and no setting is changed.
- **The engine still recognises the command:** the local engine still answers the payment intent (`action_record_payment`), now with the refusal and the link.

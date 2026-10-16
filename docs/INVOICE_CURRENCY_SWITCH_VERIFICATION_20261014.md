# Selected-service currency switch — verified existing invoice repair

The parent browser reviewer reported an **unsaved** Staging defect on deployed patient-design `add3b2b5076964dcf39c106075970018b0dac096`: selecting fixed orthodontics at250000YER, then changing toSAR, kept250000 in the price field, retained the YER catalogue label, and displayed250000SAR as the total. This worker did not open that patient or read the Staging database.

The defect is **already repaired on invoice delivery961f498b9edd7dc1b3c10b5661b828d244ffc8ff**. The existing implementation came from **32578163a79ca0e66f74f1f7d9fcfefd2fd91eb0**. This follow-up adds a durable regression and documentation only; no product-price code, financial formula, permission, service setting, CI gate, migration, main branch or deployment is changed.

## Before and after

Two actual built applications used separate disposable PostgreSQL18.6 databases/servers and synthetic patients, services and actors only:

| Source | Decisive result |
|---|---|
| Deployed sourceadd3b2b5, checked out detached locally | **2/2 selected normal-form cases fail**, at390 and1280: expectedSAR price`1800.00`, actual`250000`. Actual screenshots also show the old250000YER catalogue label and250000SAR total. No invoice saved.13 unrelated cases were excluded by the explicit test-name filter; this is not a complete baseline-suite claim. |
| Invoice source961f498b | **19/19 browser/API cases pass**, zero skipped: all15 new regression cases plus the existing4 owner-acceptance cases. |
| Existing catalogue/price-authority units | **9/9 pass**, zero skipped, in`invoice-catalog-price.test.ts` and`invoice-pricing.test.ts`. |
| Focused ESLint / typecheck | Pass. |

The synthetic independently configured catalogue prices are **250000YER /1800SAR /625USD**, stored as250000/180000/62500minor. These prices deliberately differ from FX suggestions. They are not claims about any real clinic catalogue.

The old UI uses native scope buttons, while the invoice UI uses a native select. The detached baseline's test setup changes exactly that one interaction to click its existing “الفكّان” button. The price expectations and assertions remain identical. `currency-before-test-adapter.patch` records that sole setup difference. The first baseline probe failed on that old-widget mismatch and is retained separately; it is not the currency-defect reproduction.

## Requirement → code → test/evidence

| Requirement | Existing authority | Regression proof |
|---|---|---|
| Change selected service fromYER toSAR/USD without relabelling its old number | `InvoiceForm.changeCurrency` in`components/PatientLedger.tsx`; `lib/invoice-catalog-price.ts` | Choose orthodontic service first; verify initialYER, thenSAR,USD,andYER again, on normal/historical forms at390/1280. Field and selected catalogue option agree; no spurious override reason appears. |
| Missing native price clears and blocks; no guessed FX/automatic zero | `invoiceCatalogPrice`; form input problems; `lib/invoice-input.ts` | MissingSAR/USD raw native fields areNULL; the shared service DTO's optional converted suggestion is not accepted as a native agreement quote. Empty field blocks Save. Explicit new-currency input is required. |
| Manual prices/reasons belong to their stated currency | `changeCurrency`; `lib/invoice-pricing.ts`; `lib/price-authority.ts` | Typed catalogue override and its old reason are discarded on currency change; a manual row retains its description but clears its numeric amount. Server refuses an admin increase without a reason, a reception increase despite a reason, and doctor invoice creation. An authorized admin increase with a reason persists and is audited. Existing unpriced-service rules are preserved. |
| No stale preview reactivation during rapid changes | Preview generation/owner guard in`InvoiceForm` | Hold a real successfulSAR clinical-preview response, switch rapidly throughUSD→YER→USD, then release it. Final missingUSD remains empty/blocked, no invoice/payment created. No fabricated successful response or CSS is injected. |
| Historical paid-before values cannot be relabelled | Existing `changeCurrency` clears historical paid, discount and schedule drafts | After a currency change, paid-before input is empty and Save remains disabled until the synthetic actor explicitly enters0 in the new currency. No cash receipt is invented. |
| Final server facts use the selected currency | `app/api/invoices/route.ts`; `parseInvoiceCommand`; current server pricing authority | Three actual UI saves verify request currency, canonical invoice/item amounts, and exact PostgreSQLbigint text inYER/SAR/USD. No payments or visits exist for those independent-entry patients; no latest visit is guessed. Existing stale-catalogue and idempotent-replay assertions remain in the companion acceptance suite. |

`__tests__/security-http/invoice-currency-transition-ui.test.ts` is the only new executable file. The existing companion acceptance and unit files are unchanged. The browser screenshots are actual application captures; some capture the immediate price update while clinical preview is pending. The tests separately await validated preview/Save readiness and verify real persisted server facts.

## Exact commands and provenance

Evidence root: `/workspace/reviews/invoice-resume-20261014/`. Root app build**4h-_Kt7PgtwFDtmSGqMYR**, application SHA256**204edb2b84038118007fb4b5b89fb8c45dc0ff80adc314dbba4987ffe5c94d92** remains identical to invoice961f498b's successful [requiredCI38548186976](https://github.com/Aqlanf10/aqlan-center-mini/actions/runs/38548186976), all83 steps /zero skipped. Source plus tests for the final focused runs: **8a509090183b6dbc1fa70aa5c980f313bee16ae9c5a380b35ef49d1b37f59fe1**. Each metadata JSON records before/after HEAD/hashes, exact argument array, elapsed time, exit code and raw log SHA256.

```sh
# Invoice checkout961f498b, synthetic PG55439 /HTTP3322:
npm run test:security-http -- __tests__/security-http/invoice-currency-transition-ui.test.ts __tests__/security-http/invoice-workspace-acceptance-ui.test.ts --reporter=default --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/currency-invoice-961-confirmed-results.json
npx eslint __tests__/security-http/invoice-currency-transition-ui.test.ts
npm run typecheck
npm test -- __tests__/invoice-catalog-price.test.ts __tests__/invoice-pricing.test.ts --reporter=default --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/currency-final-unit-results.json

# Separate detached deployed-source checkoutadd3b2b5, PG55440 /HTTP3323:
npm run build
npm run test:security-http -- __tests__/security-http/invoice-currency-transition-ui.test.ts -t 'normal.*after selecting' --reporter=default --reporter=json --outputFile=/workspace/reviews/invoice-resume-20261014/currency-deployed-add3-refined-before-results.json
```

Node22.23.3/npm11.9.0, Asia/Aden and systemChromium151 were used. HTTP recreates only its synthetic`aqlan_sec_http` database. Local provenance sets`CI=true GITHUB_ACTIONS=true GITHUB_RUN_ID=0 GITHUB_RUN_ATTEMPT=1` and the actual checked-out sourceSHA; runID0 is never represented as a GitHub run. No two harnesses share a port/database server.

The initial invoice probe recorded12pass/7fail. Four historical expectations wrongly expected Save to enable without re-entering the deliberately cleared paid-before value; three SQL assertions expected a number although the directpg client returnsbigint text. Those test mistakes were corrected without changing product code or relaxing guards. The final19-case run is distinct and fully passing. All earlier logs are retained.

Actual evidence: **31 invoice PNGs plus4 old-source PNGs**, witness JSON, source-bound metadata/results and the baseline adapter diff. Bundle`currency-switch-evidence-961f498b.zip`, SHA256**b168443e606c47f2a366b421382bcd26c8a4e9748fd7df4d8a58bb529461aa81**,5522260bytes. `currency-switch-actual-evidence-manifest.json` hashes every image. The old-source screenshots and failures are diagnostic evidence, not acceptance.

The enclosing test/documentation commit will have a new deliverySHA and requires its own exact-head CI before being described as fully verified. Final status is recorded externally after that commit to avoid a recursive unverified documentation head. The application's existing961f498b result does not substitute for the new test head's CI.

## Boundaries

No merge or deployment is currently authorized. The earlier separately authorized local invoice/design merge remains paused, local and unpushed at8d50eb67; it was not reused for this proof. PR330's newerfec2249 WIP is excluded. The previously reproduced cross-owner live financial-refresh defect remains **unfixed** on that paused integration checkout; this currency verification does not claim to repair it. Receptiona91fec44 and unrelated inventory/HR work remain excluded.

# Clinic Go-Live Master Audit — AQLAN CENTER MINI

| Item | Value |
|---|---|
| Audited commit | `7c052f3110ff8c8a94e4ff76e2ca96a027d69f33` (`main`, merge of PR #53) |
| Audit date | 2026-09-22 |
| Type | Read-only audit + testing. **No application code changed. Production not touched. No merge, no PR.** |
| Parallel-work boundary | CI remediation, TD-08A restore drill and PostgreSQL restore verification belong to another agent. This audit **read** that code/docs only and made no CI/TD-08A change. |
| Evidence environment | Local disposable PostgreSQL **18.6** container + the **production build** of the app (`.next/standalone`, `NODE_ENV=production`) against throwaway databases (`aqlan_audit_e2e`, and the test suites' own isolated DBs). |

> **Reading guide.** Section 1 is for the owner (Arabic, plain language). Everything after it is the evidence an engineer needs to verify each claim. Every major conclusion below was either **executed** (marked ▶ EXECUTED) or read directly in code with a file:line reference (marked 📄 CODE). Anything that could not be verified is marked **UNKNOWN**.

---

## 1. ملخص للمالك (بلغة غير تقنية)

### الحكم باختصار

البرنامج **ليس بدائيًّا** — هو نظامٌ كبير وأغلبه يعمل فعلًا: تسجيل المرضى، المواعيد، شاشة اليوم والكراسي، الزيارة السريرية بتوقيع الطبيب، الفواتير، القبض والردّ بثلاث عملات، أوامر المختبر، التقويم والسيفالو، المخزون، وسجل التدقيق. شغّلتُ كل اختباراته على نسخة الإنتاج المبنيّة فنجحت كلها (أكثر من ٢٬٦٠٠ فحص)، ثم **شغّلتُ يوم عيادة كاملًا** عبر الواجهة البرمجية الحقيقية (١١٨ فحصًا) ومسحتُ ٢١ شاشة في متصفح حقيقي.

**لكن لا أنصح ببدء الاستخدام الكامل في المركز الآن.** وجدتُ ثلاث مشاكل تُفقد مالًا أو تُفسد أرصدة بصمت، ومشكلة بنية تحتية (النسخ الاحتياطي) لم تُثبَت بعد. كلها قابلة للإصلاح دون إعادة بناء أي شيء.

**يمكن البدء بتجربة محدودة (Pilot)** للاستقبال والمواعيد والملف السريري والقبض من المرضى — بشرط الالتزام بالقواعد المؤقتة في القسم ١٢ — بعد إثبات النسخ الاحتياطي فقط.

### المشاكل الحاجبة (P0) — يجب إصلاحها قبل الاعتماد الكامل

**① عمولات الأطباء تُحسب خطأً (ثلاثة أخطاء مُثبتة بالتشغيل)**
- **ما الخطأ:** (أ) تكلفة المختبر **لا تُخصم** من عمولة الطبيب أبدًا، مع أن النظام مصمَّم ليخصمها. (ب) إذا ضبطتَ «إعدادات عمولة متقدمة» لطبيبٍ واحد من شاشة المستخدمين، **تختفي عمولة جميع الأطباء الآخرين** من التقرير. (ج) إذا غيّرتَ نسبة طبيب، **يُعاد حساب عمولته على أموال قُبضت في الماضي** بالنسبة الجديدة — ولا يُسجَّل التغيير في سجل التدقيق.
- **لماذا يهمّك:** العمولة مالٌ يُصرف من الصندوق. خطأٌ فيها يعني دفع زيادة لطبيب، أو ظلم طبيب آخر، أو خلافًا لا يمكن حسمه لأن التقرير يتغيّر بأثر رجعي.
- **مثال حدث في الاختبار:** تاج بـ٦٠٬٠٠٠ ريال، تكلفة المختبر ٢٠٬٠٠٠، نسبة الطبيب ٣٠٪ ⇒ الصحيح ١٢٬٠٠٠ — **النظام أظهر ١٨٬٠٠٠** (زيادة ٦٬٠٠٠ على تاجٍ واحد). ثم لمّا ضبطتُ إعداد عمولة للطبيب أ فقط، **اختفت عمولة الطبيب ب (٢٬٧٦٠) من التقرير كليًّا**. ولمّا رفعتُ نسبة الطبيب ب من ٤٠٪ إلى ٥٠٪ صارت عمولته عن الشهر الماضي نفسه ٣٬٤٥٠ بدل ٢٬٧٦٠.
- **الإصلاح:** تمرير تكلفة المختبر إلى حساب العمولة؛ دمج إعداد الطبيب المتقدّم مع نسبة البقية لا استبدالها؛ حفظ «نسبة الطبيب وقت الفاتورة» وتسجيل أي تغيير نسبة في التدقيق؛ واختبارات تُثبت ذلك.
- **الأولوية:** P0 · **يعتمد على:** لا شيء — يمكن البدء فورًا.

**② دفعات الموردين والمختبرات: خطأ واحد في الإدخال لا يُصحَّح**
- **ما الخطأ:** يمكن أن تُسجَّل دفعة لمورد أكبر بكثير من الدَّين (قبل النظام ٩٩٩٬٩٩٩ على فاتورة متبقيها ٣٠٬٠٠٠). وسند الصرف المرتبط بفاتورة مورد **لا يمكن إبطاله** («يُدار من لوحة الالتزامات») — ولا توجد في النظام أي أداة لإبطاله أو عكسه.
- **لماذا يهمّك:** خطأ طباعة واحد يُفسد رصيد المورد ودفتر الصندوق إلى الأبد.
- **الإصلاح:** منع الدفع فوق المتبقي (مع صلاحية تجاوز موثَّقة)، وإضافة «عكس دفعة مورد» بقيدٍ معاكس وسبب.
- **الأولوية:** P0 · **يعتمد على:** لا شيء.

**③ النسخ الاحتياطي خارج المنصة واستعادته لم يُثبتا بعد**
- **ما الخطأ:** تجربة الاستعادة الكاملة (TD-08A) غير مكتملة، وتفعيل النسخ الإنتاجي ينتظر اعتمادك، وجوجل درايف غير متصل، وحالة مخطط قاعدة الإنتاج لم يتحقق منها أحد بقراءة مباشرة (TD-REG-001).
- **لماذا يهمّك:** إن تعطّل الخادم أو حُذفت القاعدة يضيع ملف كل مريض وكل سند.
- **الإصلاح:** يعمل عليه وكيلٌ آخر الآن (لم ألمسه). لا تُدخل بيانات حقيقية قبل أن ترى بعينك استعادة ناجحة من نسخة خارج Railway.
- **الأولوية:** P0 · **يعتمد على:** مسار TD-08A الجاري.

### مشاكل كبيرة (P1) — قبل التشغيل الطبيعي

1. **دفعة مكرّرة عند الضغط مرتين أو ضعف الشبكة:** الخادم يدعم منع التكرار، لكن شاشة القبض لا تستعمله — أرسلتُ نفس الدفعة مرتين فصدر **سندان**.
2. **مركز التقارير لا يفتح إطلاقًا** (يظهر خطأ بالإنجليزية «Reload / Back») — لأي مستخدم، منذ إنشائه في ٣١ أغسطس. السبب خطأ برمجي بسيط في شكل البيانات بين الشاشة والخادم. (التقرير اليومي والمديونية والعمولات والتنفيذي تعمل.)
3. **إقفال الصندوق لا يكشف العجز:** شاشة الإقفال تملأ «المعدود» بالمتوقَّع مسبقًا، والنظام لا يحفظ المتوقَّع ولا الفرق، ويكتب على **كل** وردية مغلقة «مقفل ومطابق» حتى لو كان فيها عجز.
4. **تعديلات لا تُسجَّل في التدقيق:** إنشاء/تعديل ملف مريض (الاسم والهاتف)، إنشاء/تعديل الجهات (الأطباء والمختبرات والموردين) بما فيها **نسبة العمولة**، فواتير الموردين، وتعديل أسعار الخدمات.
5. **نقل بيانات المركز القديم غير ممكن من البرنامج:** لا توجد أداة استيراد للمرضى، والرصيد الافتتاحي للمريض **بالريال اليمني فقط** — فلا يمكن نقل دَين قديم بالسعودي أو الدولار.
6. **الطبيب يستطيع وضع أي سعر للإجراء:** الخادم يقبل السعر الذي تُرسله الشاشة؛ سجّلتُ حشوة سعرها ١٥٬٠٠٠ بسعر **١ ريال** وقُبلت. لا يوجد اعتماد للخصومات.

### ما يعمل جيدًا ويمكن الاعتماد عليه
الدفعات والردود **لا تُعدَّل ولا تُحذف** حتى من داخل قاعدة البيانات؛ الردّ لا يتجاوز أصل السند حتى مع ضغطتين متزامنتين؛ العملات الثلاث تبقى منفصلة؛ لا قبض بلا وردية مفتوحة؛ الزيارة الموقّعة لا تُعدَّل إلا بملحق؛ لا يُحذف مريض له أثر مالي؛ الطبيب لا يرى مرضى زميله؛ الاستقبال لا يرى الأرباح ولا يغيّر الإعدادات؛ تعطيل المستخدم يطرده فورًا؛ الحماية من الهجمات الشائعة (CSRF، حقن SQL، تخمين كلمات المرور) تعمل.

---

## 2. Method and evidence base

### 2.1 Test suites run on the audited commit (▶ EXECUTED)

`npm run verify:full` (the repository's canonical CI-equivalent gate) on PostgreSQL 18.6:

| Gate | Result |
|---|---|
| Environment contract, typecheck, lint, money-aggregation guard | ✅ |
| Unit tests | ✅ 168 files · **2,193 / 2,193** |
| PostgreSQL 18 integration tests | ✅ 31 files · **218 / 218** |
| Schema contract drift (committed vs fresh PG18) | ✅ identical — 61 tables · 742 columns · 639 constraints · 184 indexes · 8 triggers |
| Schema ownership characterization | ✅ written |
| Operational verification journeys | ✅ **20 / 20** |
| Baseline manifest verify, dependency audit, raw-body scanner, production build | ✅ |
| HTTP security integration tests (built app) | ✅ 21 files · **213 / 213** |
| **Overall** | ✅ **16/16 steps in 10.3 min** |

Environment notes (not app defects): the sandbox's Chromium build differed from the pinned Playwright build, so the existing browser binary was symlinked to the expected path (no `playwright install`). `docker compose up -d pg18` **fails on the current `postgres:18-alpine` image** because `docker-compose.yml` mounts `/var/lib/postgresql/data`, which PG18 images reject; a plain `docker run` without that volume was used. This belongs to the TD-02/CI workstream and is only reported (P3-10).

### 2.2 Black-box clinic scenarios (▶ EXECUTED)

A scratch driver (kept outside the repository) started the **production build** against a fresh empty database, performed the owner's real first-run path (`/api/auth/setup` with `SETUP_TOKEN`), created staff through `/api/users`, and drove every scenario over HTTP exactly as the screens do (session cookies, same-origin header). Direct SQL on that **throwaway** database was used to confirm what was stored, plus two deliberate writes: an attempted `UPDATE`/`DELETE` on a payment (to prove the append-only triggers refuse it) and one reset of `users.commission_config` to isolate the retroactive-rate test (P0-1c). Final pass: **118 checks — 100 pass / 18 fail**; every one of the 18 failures is analysed below and is a genuine application behaviour (driver mistakes found in earlier passes — YER has no decimals; the clinical API takes minor units — were corrected and re-run).

### 2.3 Real-browser sweep (▶ EXECUTED)

Chromium over 21 staff screens × 3 widths (1366 / 768 / 390 px) as the owner: **63 checks — 59 pass / 4 fail** (Reports Center crash ×3 widths; `/lab` overflows 113 px at 390 px). RTL (`dir="rtl"`, `lang="ar"`) present on every working screen.

### 2.4 Code review (📄 CODE)

All 136 API routes inventoried for session/role checks; schema contract inspected for types/FKs/checks; finance, commission, shift, audit, patient, lab, inventory, AI and print modules read at the cited lines.

---

## 3. Architecture inventory (Part 1)

| Layer | Verified reality |
|---|---|
| App | One Next.js 16.3 App Router app (React 19.2, TypeScript) — UI and API in the same deployable. **68 pages, 136 API routes.** |
| Data access | Plain `pg` SQL, no ORM. `lib/db.ts` is **18,473 lines** holding most domains (TD-REG-007). 134 `lib/*.ts` modules. |
| Database | PostgreSQL (CI and target = 18). **61 tables.** Money = `int8` minor units everywhere; FX rates `numeric`. No floating-point money (floats only in cephalometric geometry). |
| Schema ownership | Two paths: numbered migrations `0001–0011` **and** runtime `ensureSchema()` DDL (275 call sites). Production adoption of the migration chain is **not proven** (TD-REG-001, P0 in the register). |
| Auth | Signed session cookie (`HttpOnly; Secure; SameSite=lax`, 12 h), credential version in the token (password reset / disable revokes sessions — ▶ EXECUTED). Separate patient portal session. First admin via `SETUP_TOKEN` only while the users table is empty (race-safe `INSERT … WHERE NOT EXISTS`). |
| Authorization | Server-side, per route; **3 roles only** (`lib/roles.ts:19`: admin / reception / doctor) + per-doctor permission flags + patient-ownership rule (`lib/patient-access.ts`, `doctorOwnsPatient` in `lib/db.ts:10204`). Policy scattered across routes (TD-REG-006). |
| Audit | `audit_log` (append-only by trigger), `recordAudit` never throws by design. Actor, role, action, entity, id, JSON details; **no request metadata** (IP / user-agent). |
| Finance | Invoices (per-agreement currency), payments/refunds (append-only, idempotency key, partial refunds under row lock), expenses/vouchers (append-only, reversal rows), payables (supplier/lab bills), cashier shifts, opening balances, FX revaluation, double-entry journal views, period lock. |
| Printing | 14 print routes under `app/print/*` (receipt, invoice, voucher, statement, plan, prescription, consent, post-op, lab order, appointment card A6, patient card, dossier, ceph, ceph-compare) with clinic identity from Settings and reprint marking (`document_prints`). |
| Settings | 44 typed keys (`lib/settings-definitions.ts`) with category permissions, optimistic versions, required reasons, before/after audit. |
| Backups | Rich subsystem (`lib/backup*.ts`, AES-256-GCM, retention, history); production activation pending owner; Google Drive not connected; TD-08A restore drill incomplete. |
| AI | Optional external LLM providers (OpenAI, Z.ai, DeepSeek, Anthropic presets), tool registry with permission matrix and confirmation claims, regex de-identification. |
| Tests | 168 unit files, 31 PostgreSQL files, 21 HTTP-security files, 24 journey scripts; one CI job; required check `Typecheck, Lint, Test, Postgres, Audit, Build`. |
| Deploy | Dockerfile → Railway (`/api/health`), `main` → production; no persistent staging (TD-REG-010). |

---

## 4. Findings register

Severity per the brief: **P0** = money loss / corruption / breach / cannot do core work · **P1** = must fix before normal operation · **P2** = should fix soon · **P3** = polish.

### P0 — go-live blockers

#### P0-1 Doctor commission calculation is not trustworthy (three proven defects)

| | |
|---|---|
| **1a. Lab cost is never deducted** | ▶ EXECUTED: crown invoiced and collected 60,000 YER, lab order cost 20,000 YER against the lab party, doctor at 30% ⇒ expected 12,000; report returned `earnedMinor: 18000`. 📄 CODE: `lib/commission.ts:273` deducts `share.labCostMinor`, but the only producer of shares, `lib/db.ts:9044` (`invoice.doctorShares.push`), never sets `labCostMinor`; no test anywhere covers lab deduction in commissions (`grep labCostMinor __tests__` → only `profitability.test.ts`). |
| **1b. Configuring one doctor zeroes all others** | ▶ EXECUTED: doctor B earned 2,760 YER; owner saved an advanced commission profile for **doctor A only** (`PATCH /api/users/:id {commissionConfig}`); doctor B's row **disappeared** from `/api/finance/commissions`. 📄 CODE: `lib/db.ts:9272` passes `configByDoctor.size > 0 ? configByDoctor : percentByDoctor` — when any doctor has a config, doctors without one are absent from the map, and `lib/commission.ts:242` does `if (docEntry === undefined) continue;`. The comment above it states the opposite intent. |
| **1c. Rate changes rewrite the past, unaudited** | ▶ EXECUTED: doctor B 40% → 50% via `PATCH /api/parties/:id`; commission on the **same past collections** changed 2,760 → 3,450. 📄 CODE: `lib/db.ts:9025` reads the *current* `parties.commission_percent` for all historical invoices (no rate snapshot). `app/api/parties/[id]/route.ts` has no `recordAudit` (▶ 0 audit rows for any party change). |
| Why it matters | Commission is cash paid out every month; the report can over-pay, silently drop a doctor, or change last month's figures after they were paid. |
| Fix | Populate `labCostMinor` per share from lab orders linked to the invoice's visit/tooth (respecting `deductLabCost`); resolve each doctor's policy as *config if present else party percent*; snapshot the applicable rate (or use the existing `rateHistory` for both paths) so rate changes are effective-dated; audit party create/update with before/after; add PostgreSQL tests for all three. |
| Dependencies | None. |

#### P0-2 Supplier / lab bill payments: overpayment accepted and no correction path

| | |
|---|---|
| Evidence | ▶ EXECUTED: supplier bill 50,000 YER; voucher 20,000 against it; a second voucher of **999,999 YER** against the same bill (remaining 30,000) returned **201**. Voiding a bill-linked voucher returned **409** "السند يسدّد التزامًا — التسوية تُدار من لوحة الالتزامات". 📄 CODE: `recordExpense` (`lib/db.ts:8786`) has no remaining-balance check for `payable_id`; `voidExpense` refuses `settles_payable` (`lib/db.ts:8901`); `app/api/payables/route.ts` exposes only `GET`/`POST` — no void/reverse exists anywhere. Supplier bill creation is also unaudited (▶ 0 rows). |
| Why it matters | One typing mistake permanently corrupts a supplier/lab balance and the cash book, with no in-app correction. |
| Fix | Block payment beyond the bill's remaining amount (explicit, audited override if the owner wants prepayments); add a payable-payment reversal that writes a counter-voucher with reason; audit payable create/settle. |
| Dependencies | None. |

#### P0-3 Data-safety infrastructure unproven: off-site backup + restore, production schema state

| | |
|---|---|
| Evidence | 📄 DOCS: `docs/TECHNICAL_DEBT_MASTER_REGISTER.md` TD-REG-001 (P0, production schema adoption unproven) and "TD-08A remains incomplete"; `docs/PRODUCTION_BACKUP_GATE.md` "لا تفعيل إنتاجي قبل مراجعة المالك"; Google Drive destination `not_connected`. |
| Why it matters | Without a proven restore from an off-platform copy, a single platform incident loses every patient record and receipt. |
| Fix | Owned by the parallel CI/TD-08A workstream — **not touched by this audit.** Go-live gate: one witnessed restore of a real production-shaped archive from off-platform storage, then TD-01B read-only preflight. |
| Dependencies | TD-08A → TD-01A → TD-01B (register order). |

### P1 — must fix before normal operation

| ID | Finding | Evidence | Fix |
|---|---|---|---|
| **P1-1** | **Duplicate receipts on double submit / network retry.** Server supports `Idempotency-Key`, the only payment screen never sends it. | ▶ Two identical concurrent POSTs without key → **2 receipts**; with the same key → exactly 1 (`payment.idempotent_replay`). 📄 `components/CollectPaymentModal.tsx:124` (no header); guard is only a React `busy` flag. | Generate a key when the modal opens and send it on every attempt; keep until success. |
| **P1-2** | **Reports Center crashes for every user** ("This page couldn't load / Reload / Back"). | ▶ Browser: `TypeError: Cannot read properties of undefined (reading 'title')` on `/reports` at all widths, fresh or populated DB; API itself returns 200. 📄 Root cause: `app/api/reports/route.ts:39` returns the report **flattened** (`{...result, generatedAt}`) while `app/reports/page.tsx:79,290` expects `{ result: … }` → `data.result` is `undefined`. Both files unchanged since `d126bdf` (2026-08-31) — broken since introduced. `screens-render` HTTP test does not catch client-side crashes. | Align the contract (wrap in `{ result }` or read the flat shape) + a browser test that asserts no page error on `/reports`. |
| **P1-3** | **Shift close hides shortages.** | ▶ Closed with counted 50,000 YER vs a different expected total: `cashier_shifts` stores **no expected amount and no difference** (columns: opening_*, counted_* only). 📄 `app/finance/reconciliation/page.tsx:175` pre-fills "counted" with the expected amount; `:304` renders **«مقفل ومطابق»** for every closed shift regardless of the count. One clinic-wide shift only (not per cashier). | Store expected per currency at close, compute and display the difference, require a reason when non-zero, blind count (no pre-fill), print a close (Z) report. |
| **P1-4** | **Audit gaps on sensitive edits.** | ▶ 0 audit rows after: patient create + demographic edit via the normal screens (`app/api/patients/route.ts:97`, `app/api/patients/[id]/route.ts:119` — `patient.update` is only written by the AI tool path); party create/edit incl. commission % (`app/api/parties/*`); supplier bill (`app/api/payables`); service price edit (`app/api/services/[id]` has no `recordAudit`). Settings, users, permissions, payments, refunds, shifts, invoices, lab, inventory, visits **are** audited (▶). | Add `recordAudit` with before/after to these four routes; add the mutation→audit matrix test proposed in TD-REG-009. |
| **P1-5** | **No path to bring the old center's data in.** | 📄 No patient/appointment/balance importer exists (`scripts/`, `app/api` — only CSV *export*). `patient_opening_balances` has **no currency column** (`lib/db.ts:1393`; contract columns: amount_minor, as_of_date, note…) → legacy SAR/USD debts cannot be carried over in their currency. | Build an importer with dry-run on an isolated DB (rows read / inserted / rejected report), patient-number preservation + sequence bump, duplicate policy, and currency-aware opening balances. (Owner decisions needed — see §12.) |
| **P1-6** | **Server trusts the client's procedure price; no discount authority.** | ▶ Doctor saved a catalog 15,000 YER procedure at `unitPriceMinor: 1` → stored `1`, invoice would bill 1 YER. 📄 `app/api/visits/[id]/clinical/route.ts:165` → `lib/db.ts:11646`. Same pattern allows inflating a price (which also inflates commission). | Default to catalog price server-side; allow deviations only with a permission + reason (audited), or cap discount %. |

### P2 — should fix soon

| ID | Finding | Evidence |
|---|---|---|
| P2-1 | Only 3 roles — no accountant, assistant, cashier or lab role. | ▶ `role: "accountant"` / `"assistant"` → 400 "اختر الدور". `lib/roles.ts:19`. |
| P2-2 | No self-service password change; only admin can change passwords. | ▶ reception `PATCH /api/users/<own id> {password}` → 403 "إدارة المستخدمين للمدير وحده". |
| P2-3 | Same patient can be double-booked at the same time. | ▶ Second appointment, same patient/date/time/doctor → 201. |
| P2-4 | Cancelling an invoice that already has money on it needs no reason and gives no refund/credit guidance. | ▶ admin cancel of a partially paid invoice → 200; audit details have amount only. 📄 `app/api/invoices/[id]/route.ts:55`. |
| P2-5 | Opening balances are overwrite/delete (upsert + `DELETE`), not append-only; audited but with no before value on overwrite. | 📄 `lib/db.ts` `setPatientOpeningBalance` (`ON CONFLICT DO UPDATE`), `clearPatientOpeningBalance` (`DELETE`). |
| P2-6 | No patient archive/deactivate; admin hard-delete removes clinical history (signed visits, x-rays, prescriptions, ortho, ceph) when the patient has no financial footprint. | 📄 `lib/db.ts` patient delete (~4150–4290); guarded by admin + typed patient number + financial-footprint check (▶ refused with money). |
| P2-7 | Duplicate detection is warning-only and there is no merge tool. | ▶ 409 warning on same name+phone, `confirmDuplicate` bypass. TD-REG-012. |
| P2-8 | Patient demographics thin: birth **year** only, no emergency contact, no national ID, no second-language name. Medical history via `medical_alert` + portal intake forms. | 📄 schema `patients`, `patient_intake_forms`. |
| P2-9 | No DB `CHECK` constraints on money tables (amount > 0, currency ∈ YER/SAR/USD, kind). API validation is correct (▶ negative/junk/EUR rejected) but there is no defence in depth. | 📄 contract: `payments`, `expenses`, `invoices` checks = 0. |
| P2-10 | Inventory purchases are not linked to supplier bills (two separate manual entries). | 📄 `inventory_movements` has no party/payable link. |
| P2-11 | AI assistant can send de-identified clinical text to external providers incl. Z.ai/DeepSeek; de-identification is regex-based (only explicitly known names are masked). | 📄 `lib/ai-tools/privacy.ts`, `lib/ai-providers/presets.ts`, `lib/ai.ts` default provider `zai`. |
| P2-12 | Missing plan modules: complaints, one-step checkout (clinical + payment + next appointment), outbound reminders are manual WhatsApp links. | 📄 `docs/CLINIC_OPERATIONS_IMPLEMENTATION_PLAN.md` §6 / phase 6 "لم تُبدأ". |
| P2-13 | Test-quality gaps that let P0-1/P1-2 ship: no commission test with lab cost or mixed config; screen tests check HTTP 200 not client errors. | See §8. |
| P2-14 | Commission payouts are ordinary vouchers; no doctor-signed settlement statement / print. | 📄 no `app/print/*commission*`. |

### P3 — polish / later

| ID | Finding |
|---|---|
| P3-1 | Document prefixes hard-coded (`P-`, `INV-`, `R-`, `V-`) — `lib/db.ts:7298,7757,…`; sequences are race-safe. |
| P3-2 | Default FX rates pre-filled (SAR 140, USD 530) — `lib/settings.ts:81-82`; a forgotten update skews base-equivalent reports (per-currency buckets are unaffected). |
| P3-3 | Per-username lockout (4 wrong attempts → 15 min) lets anyone lock the owner out (▶ observed during the brute-force test). |
| P3-4 | `/lab` overflows 113 px at 390 px phone width (▶). |
| P3-5 | Audit rows lack IP / user-agent. |
| P3-6 | Expense vouchers have no attachment (photo of receipt). |
| P3-7 | `README.md` 71 KB monolith; `docs/DATABASE_MIGRATIONS.md` stale (TD-REG-014/020). |
| P3-8 | Referral workflow absent (1 incidental text hit). |
| P3-9 | Previously uncommitted "Today's Clinic filters" (J06) work was lost when the session container was reclaimed; nothing on `main` is affected. |
| P3-10 | `docker-compose.yml` PG18 volume path incompatible with current `postgres:18-alpine` (dev tooling; TD-02 owner). |

**Counts: P0 = 3 · P1 = 6 · P2 = 14 · P3 = 10.**

---

## 5. Module audit (Parts 2–25)

### Part 2 — Roles and permissions — **MOSTLY_COMPLETE (3 roles)**
▶ Login/logout, admin reset (revokes sessions), disable (revokes sessions immediately), rate-limited login (429 after 4), reception blocked from audit/settings/users/commissions, doctors blocked from money and from colleagues' patients (403 on clinical notes, ortho patient view), reception blocked from clinical notes and invoice cancel. Route inventory: every route checks the session except intentionally public ones (`auth/*`, `book` (rate-limited), `display` (masked names), `health`, `ping`, `portal/login|logout`) and `internal/backup/run` (timing-safe token); backup routes use `requireBackupAdminReadOnly`. Gaps: P2-1, P2-2; policy scattered (TD-REG-006).

### Part 3 — Patients — **MOSTLY_COMPLETE**
▶ Register, duplicate warning, search by phone and by name (Arabic), edit, `P-00002` numbering, medical alert, delete blocked with money. Documents/x-rays with soft-remove and hashes; diagnoses versioned (`supersedes`). Gaps: P1-4 (no audit), P1-5 (no import), P2-6/7/8.

### Part 4 — Appointments and reception — **MOSTLY_COMPLETE**
▶ Book, check-in → queue visit linked to appointment and doctor, call/seat chair (chair+day advisory lock from PR #39), no-show/cancel, reschedule (PR #41), waiting list with booking recovery (PR #38). Capacity engine, provider blocks, status log, reminders, recall screen. Gap: P2-3. Today's Clinic filters (doctor/shift/search) remain **MISSING** (see `docs/TODAYS_CLINIC_READONLY_AUDIT.md`).

### Part 5 — Clinical visit — **MOSTLY_COMPLETE**
▶ Complaint / examination / diagnosis / treatment done / next plan, procedures with tooth, sign → invoice in one transaction, signed visit immutable (409), addendum. FDI tooth chart, prescriptions (void with reason), consent and post-op prints, radiographs as documents. Gaps: P1-6 price trust; referral absent (P3-8).

### Part 6 — Treatment plans — **MOSTLY_COMPLETE**
▶ Plan with currency (SAR) and installments; 📄 items locked after consent (`lib/plans.ts:341`), billing rules per item, sessions/planned visits. Changing price *after* payment is prevented once consented; before consent items remain editable (acceptable). Partial completion tracked per item.

### Part 7 — Orthodontics — **READY (clinical) / PARTIAL (financial via P0-1)**
▶ Ortho case (appliance, arches, slot, planned months, plan link), adjustment with wires/elastics/next interval, SAR plan payments, next appointment. 📄 Phases incl. retention, photos by stage/view, follow-up of missed adjustments, ceph with 49 measurements, reports and superimposition (`verify:ceph` ✅). Doctors must be linked to the patient (appointment/visit/active plan) before opening a case (by design). Cephalometrics: clinical tool with documented reference sets; accuracy depends on calibration (`ceph_analyses.cal_*`).

### Part 8 — Dental lab — **MOSTLY_COMPLETE**
▶ Order with work type, tooth, shade, lab party, cost → payable auto-created, status history (`lab_order_tracking`), remake support, patient billed via visit. Gaps: commission deduction broken (P0-1a); payable payment correction (P0-2).

### Part 9 — Inventory — **MOSTLY_COMPLETE**
📄 Items, in/out/adjust, returns, expiry, balance check under row lock, auto-deduction per service mapping, patient cost, append-only movements (trigger). Gap: P2-10.

### Part 10 — Suppliers — **PARTIAL**
▶ Supplier party, bill, partial payment, statement (`/api/payables?partyId=`). Gaps: P0-2, P1-4 (no audit), no supplier statement print.

### Part 11 — Financial system — **PARTIAL (core ledger strong, controls weak)**
Strong (▶): append-only payments at DB level (UPDATE/DELETE blocked), partial refunds that can never exceed the original even concurrently, refund currency must match original, refund needs original, no shift → no money, currencies stored independently with FX snapshot (SAR 100.00 stored as SAR, base equivalent 14,000 at 140), foreign payment on account requires a target, invoice cancel admin-only, patient with money cannot be deleted, balances derived from amounts (status "paid" is cosmetic). Weak: P0-1, P0-2, P1-1, P1-3, P1-6, P2-4, P2-5, P2-9.

### Part 12 — Cashier / shift / daily close — **PARTIAL**
▶ Open with float per currency, single open shift enforced, payments lock the shift row, no payments after close, reconciliation shows expected per currency while open. Gap: P1-3 (no persisted expected/discrepancy, false "مطابق", pre-filled count, clinic-wide drawer).

### Part 13 — Doctor commissions — **UNSAFE** (P0-1)
Design is sound on paper (per-doctor × per-currency buckets, collected-cash basis, FIFO allocation, material-rate deduction toggle, payouts per currency); execution has the three proven defects.

### Part 14 — Account statements — **PARTIAL**
Patient: ▶ ledger API + printable statement (per-currency). Supplier/lab: ▶ API statement, **no print**. Doctor: commission screen, **no statement print** (P2-14). Opening balance, running balance per currency and period filters exist for patients; not verified for parties (UNKNOWN for running balance).

### Part 15 — Expenses — **MOSTLY_COMPLETE**
▶ Categories with budgets, voucher numbers, per-currency, void by admin with reason as a reversal row (non-payable vouchers), append-only. Gaps: no attachment (P3-6); payable-linked vouchers (P0-2).

### Part 16 — Reporting — **PARTIAL**
▶ Working: daily report (`/report`), patient debts per currency, executive dashboard, commissions, reconciliation, lab accounting. **Broken: Reports Center `/reports` (P1-2)** — which hosts the 11 report types (collections by currency/doctor, services, expenses, debt aging, etc.). Missing: shift (Z) report, supplier/doctor statement prints.

### Part 17 — Printing — **MOSTLY_COMPLETE**
▶ Receipt and patient statement render (Arabic). 📄 14 documents, clinic identity from Settings, reprint marking, `@page` margins, A6 appointment card, A4 landscape reports. Missing: shift close report, doctor/supplier statements.

### Part 18 — Settings — **MOSTLY_COMPLETE**
▶ Change requires category permission, optimistic version and reason; audited with before/after (`clinic_settings.update`: قبل 2 → بعد 3, السبب). 44 keys incl. identity, hours/shifts, capacity, FX, locked-period date, display privacy, backups. Recommended additions: document prefixes, receipt footer text, commission defaults, discount limits, blind-count toggle, per-cashier drawers.

### Part 19 — Audit log — **PARTIAL**
▶ Append-only; covers settings, users, permissions, payments, refunds, idempotent replays, shifts, invoices, expenses, lab, inventory, visits (sign/addendum/delete), appointments, waiting list, backups, AI. Missing: P1-4 set; no IP/user-agent (P3-5).

### Part 20 — Data safety and concurrency — **MOSTLY_COMPLETE**
▶ Concurrent refunds bounded; same-key payments deduplicated; single-shift race safe; chair seating/day booking advisory locks (PR #39/#41 PG tests ✅). Gap: P1-1 (UI double submit).

### Part 21 — Database quality — **MOSTLY_COMPLETE**
📄 Integer minor-unit money, thorough FKs on all core tables (payments, invoices, visits, appointments, lab_orders, payables, inventory_movements, visit_procedures…), sequences for document numbers, append-only triggers (payments, expenses, inventory_movements, audit_log). Gaps: no CHECK constraints on money tables (P2-9); `expenses.payable_id` intentionally without FK; dual schema ownership (TD-REG-001/002/005).

### Part 22 — Security — **MOSTLY_COMPLETE**
▶ Anonymous → 401, cross-origin POST → 403 (CSRF/origin), SQL-injection string inert, login rate-limited, cookie `HttpOnly; Secure; SameSite=lax`, Arabic 404 without stack, session revocation on reset/disable, 213 HTTP security tests green. Stored `<script>` in a name accepted as text (React escapes on render — not executed; UNKNOWN for print/CSV export contexts).

### Part 23 — UI/UX and RTL — **MOSTLY_COMPLETE**
▶ 59/63 screen×width checks clean (RTL, no overflow, no console errors) incl. Today board, appointments, patients, waiting list, finance, reconciliation, commissions, debts, parties, inventory, ortho, settings, users, audit, executive, recall, messages at 1366/768/390. Failures: `/reports` crash, `/lab` 390 px overflow. Reception speed: arrival → queue is one click; payment is a modal from the patient file/statement.

### Part 24 — Error handling — **MOSTLY_COMPLETE**
▶ Arabic messages for no shift (409), duplicate patient (409), invalid amount (400), refund over limit (409), wrong currency (409), expired/revoked session (401), forbidden (403). Silent failures observed: none at API level; the Reports Center crash shows an English framework page (P1-2).

### Part 25 — AI assistant — **LIMITED / EXPERIMENTAL**
📄 External providers only (no local model); requires the owner to enter an API key (no key → no calls). Tools: patient, appointment, finance, lab, inventory, ortho, clinical actions, form drafting, with a permission matrix, `canAccessPatient` checks, and confirmation claims before writes (`ai_confirmation_claims`). Privacy: regex de-identification; names masked only when passed explicitly. Prompt-injection exposure exists for any free-text clinical note sent to the model. **Recommendation: keep disabled for go-live**; re-evaluate after P2-11.

---

## 6. End-to-end scenarios (Part 26) — ▶ EXECUTED

| Scenario | Result | Where it broke / notes |
|---|---|---|
| **A** New patient → appointment → exam → treatment → invoice → partial payment → receipt → balance → statement | **PASS** (with defects) | Whole flow worked; balance and printed receipt/statement correct. Defects seen on the way: no patient audit (P1-4), procedure price trusted (P1-6), same-slot double booking (P2-3). |
| **B** Ortho patient → follow-up → note → procedure → payment → next appointment | **PASS** | SAR plan, ortho case, wire adjustment, SAR payment kept in SAR, next appointment. Doctor must be linked via appointment first (by design). |
| **C** Lab: request → cost → billing → completion → commission impact | **FAIL** | Order/payable/billing/status history all correct; **commission ignored the lab cost** (P0-1a). |
| **D** Refund / reversal | **PASS** | Partial refund OK; concurrent over-refund blocked; over-remaining, no-original and wrong-currency refunds rejected; payments immutable at DB level. |
| **E** Supplier purchase → debt → partial payment → statement | **FAIL** | Bill + partial payment + statement work; **overpayment accepted and uncorrectable** (P0-2); bill unaudited. |
| **F** Doctor production → collection → deductions → commission → statement | **FAIL** | P0-1a/b/c all reproduced. Payout voucher works. |
| **G** Daily opening → operations → payments → expenses → reconciliation | **FAIL** | Open/float/single-shift/no-shift guard/close/no-payment-after-close work; **expected & discrepancy not stored, close labelled "مطابق"** (P1-3). |
| **H** Admin changes permissions/settings → audit evidence | **PASS** | Settings (before/after + reason), permission and user changes audited; reception blocked from audit/settings/users. |

**Passed 4 (A, B, D, H) · Failed 4 (C, E, F, G).**

---

## 7. Dangerous financial cases (explicit list from the brief)

| Case | Result |
|---|---|
| Receipt twice (double click / retry) | ❌ 2 receipts without key (P1-1); ✅ 1 with key |
| Reversal twice / over-refund | ✅ bounded under concurrency |
| Deleted patient with balance | ✅ refused (409) |
| Changed treatment price after payment | ✅ blocked after plan consent; ❌ visit procedure price is free-form (P1-6) |
| Partial payment | ✅ |
| Treatment/invoice cancellation after payment | ⚠️ allowed for admin without reason; money remains as patient credit (P2-4) |
| Doctor commission after lab expense | ❌ lab not deducted (P0-1a) |
| Transaction failure halfway | ✅ payment, sign→invoice, patient delete run in single transactions (📄) |
| Concurrent payment attempts | ✅ with key; ❌ without key (P1-1) |
| Wrong currency | ✅ EUR rejected; foreign on-account needs target; refund currency must match |
| Negative / non-numeric amount | ✅ rejected (400) |
| Deleted expense | ✅ DB forbids DELETE; void = reversal row with reason (non-payable) |
| Cancelled lab work | ✅ cancel beyond "needed" is admin-only (📄 `app/api/lab/[id]/route.ts:145-151`) |
| Patient refund | ✅ |
| Supplier overpayment | ❌ accepted, uncorrectable (P0-2) |

---

## 8. Test quality (Part 27)

The suites are large, fast and genuinely behaviour-oriented (real PostgreSQL 18, real HTTP against the production build, concurrency proofs). What they miss is exactly what failed here:

1. **Commission pipeline** — tested at the pure-function level with hand-built shares; no test feeds real lab orders into `commissionReport`, and no test mixes a configured doctor with an unconfigured one.
2. **Client-side rendering** — `screens-render` asserts the server response, not browser page errors; the Reports Center crash passed CI for three weeks.
3. **UI contracts** — no test asserts that `CollectPaymentModal` sends `Idempotency-Key`.
4. **Negative supplier cases** — no overpay/void tests for payables.
5. **Audit matrix** — no meta-test that every mutating route writes an audit event (TD-REG-009).

---

## 9. Feature completion matrix (Part 29)

| Module | Status | UI | API | DB | RBAC | Audit | Tests | E2E | Real-world usability | Missing | Sev |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Auth / users | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | self password change, more roles | P2 |
| Patients | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ❌ create/edit | ✅ | ▶ ✅ | Good | audit, import, archive, merge | P1 |
| Appointments | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | same-patient overlap guard | P2 |
| Today's Clinic / queue | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | partial | ✅ | ▶ ✅ | Good | filters, actor on visit | P2 |
| Waiting list | COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (PR #38) | Good | — | — |
| Clinical visit | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | server price authority, referral | P1 |
| Treatment plans | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | — | — |
| Orthodontics | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | — | — |
| Cephalometrics | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (`verify:ceph`) | UNKNOWN (not driven) | Clinical tool; calibration-dependent | — | — |
| Lab | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | commission link (P0-1a) | P0 |
| Inventory | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | not driven | Good | supplier link | P2 |
| Suppliers / payables | PARTIAL | ✅ | ⚠️ | ✅ | ✅ | ❌ | ⚠️ | ▶ ❌ | Risky | overpay guard, reversal, audit, print | P0 |
| Payments / refunds | MOSTLY_COMPLETE | ⚠️ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | UI idempotency | P1 |
| Invoices | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | cancel reason | P2 |
| Cashier shifts | PARTIAL | ⚠️ | ⚠️ | ⚠️ | ✅ | ✅ | ⚠️ | ▶ ❌ | Risky | expected/discrepancy, Z report | P1 |
| Doctor commissions | UNSAFE | ✅ | ❌ | ⚠️ | ✅ | ❌ rate | ❌ | ▶ ❌ | Unsafe | 3 defects | P0 |
| Expenses | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | attachments | P3 |
| Opening balances | PARTIAL | ✅ | ✅ | ⚠️ no currency | ✅ | ✅ | ⚠️ | not driven | Limited | currency, append-only | P1 |
| Statements | PARTIAL | ✅ patient | ✅ | ✅ | ✅ | n/a | ✅ | ▶ ✅ patient | Partial | party/doctor prints | P2 |
| Reports Center | BROKEN | ❌ | ✅ | ✅ | ✅ | n/a | ✅ lib | ▶ ❌ | Unusable | contract fix | P1 |
| Other reports (daily, debts, executive) | COMPLETE | ✅ | ✅ | ✅ | ✅ | n/a | ✅ | ▶ ✅ | Good | Z report | P2 |
| Printing | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ reprint | partial | ▶ ✅ | Good | shift/doctor/supplier docs | P2 |
| Settings | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ▶ ✅ | Good | prefixes, discount limits | P3 |
| Audit log | PARTIAL | ✅ | ✅ | ✅ | ✅ | — | ✅ | ▶ ⚠️ | Good | 4 gaps, IP | P1 |
| Backup / restore | PARTIAL | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | UNKNOWN (TD-08A) | Unproven | restore drill, off-site | P0 |
| Patient portal | MOSTLY_COMPLETE | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (`verify:portal`) | not driven | — | — | — |
| Messages | PARTIAL | ✅ | ✅ | ✅ | ✅ | — | ✅ | not driven | Internal only | outbound templates | P2 |
| Complaints | MISSING | — | — | — | — | — | — | — | — | whole module | P2 |
| Checkout (one step) | MISSING | — | — | — | — | — | — | — | — | whole step | P2 |
| Data import | MISSING | — | — | — | — | — | — | — | — | importer | P1 |
| AI assistant | LIMITED | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | not driven | Experimental | privacy hardening | P2 |

---

## 10. What is actually left (Part 30) — dependency order

**PHASE A — Absolute go-live blockers**
1. P0-1 commission engine (1a lab deduction → 1b config merge → 1c effective-dated rates + party audit) with PostgreSQL tests.
2. P0-2 payable overpay guard + payable-payment reversal + audit.
3. P0-3 backup/restore proof and production schema preflight (parallel workstream — gate only).

**PHASE B — Core clinic completion**
4. P1-2 Reports Center contract fix + browser page-error test.
5. P1-1 payment idempotency key in the UI.
6. P1-4 audit on patients/parties/payables/service prices.
7. P2-3 same-patient overlap guard; Today's Clinic filters (J06 redo).

**PHASE C — Financial/accounting completion**
8. P1-3 shift close: expected + difference + reason + blind count + Z report.
9. P1-6 server-side price authority + discount permission.
10. P1-5 importer (dry-run first) + currency-aware opening balances (owner decisions in §12).
11. P2-4 cancel reason + credit/refund guidance; P2-5 append-only opening balances; P2-9 DB CHECK constraints.

**PHASE D — Clinical/orthodontic completion**
12. Referral; visit actor columns (who called/seated); checkout step (P2-12).

**PHASE E — Reporting and documents**
13. Doctor commission statement print; supplier/lab statement print; shift Z report print.

**PHASE F — UX/RTL/polish**
14. `/lab` phone overflow; self-service password change; roles (accountant/assistant) if the owner wants them; prefixes in Settings.

**PHASE G — Advanced / AI / future**
15. AI privacy hardening before enabling; complaints module; outbound reminder templates; inventory↔supplier purchase link; patient merge tool.

---

## 11. FASTEST_SAFE_GO_LIVE_PATH (Part 31)

**MUST_HAVE_BEFORE_DAY_1**
1. Proven off-site backup + one witnessed restore (P0-3, parallel workstream).
2. Commission fixes (P0-1) — *or* the owner explicitly decides to compute commissions outside the system until fixed (see rule R3).
3. Supplier/lab payment guard + reversal (P0-2) — *or* rule R4 until fixed.
4. Payment idempotency in the UI (P1-1) — small change, removes duplicate receipts.
5. Shift close stores expected/difference and stops saying "مطابق" (P1-3) — small change, protects the drawer.
6. Real staff accounts per person (never share the admin login).

**CAN_COMPLETE_DURING_EARLY_OPERATION**
Reports Center fix (P1-2; daily report, debts and executive screens work meanwhile), audit gaps (P1-4), price authority (P1-6), invoice-cancel reason, overlap guard, Today's Clinic filters, statements prints, importer (if the owner starts with new patients and migrates in batches).

**CAN_WAIT_UNTIL_LATER**
Extra roles, complaints, checkout step, AI, referral, inventory↔supplier link, prefixes, phone layout polish.

---

## 12. Operating rules for a limited pilot and owner decisions

Temporary rules (until the related fix lands):
- **R1** Keep the AI assistant disabled (no API key).
- **R2** Every receptionist has her own login; nobody uses the owner account at the front desk.
- **R3** Do **not** configure "advanced commission" for any doctor and do **not** change a doctor's % — compute commissions manually from the collections report until P0-1 is fixed.
- **R4** Record supplier/lab payments only after checking the remaining balance on the statement; two-person check on amounts.
- **R5** At shift close, count the drawer blind, write the count on paper, then compare with the expected figure shown before closing.
- **R6** Do not rely on the Reports Center; use the daily report, debts and executive screens.

Owner decisions required before the data import (P1-5): keep old patient numbers or renumber · duplicate policy (merge / keep both / skip) · scope (patients only, or with appointments, balances per currency, and treatment history). No patient data may enter the repository; the importer must run on an isolated database first and report rows read / inserted / rejected, and nothing may be written to production without explicit authorization and a verified backup.

---

## 13. Technical debt that matters (Part 32), dead/duplicate work (Part 33), performance (Part 34)

**Debt with real risk:** dual schema ownership and per-request DDL (TD-REG-001/002/005); 18k-line `lib/db.ts` (TD-REG-007) — slows safe changes to finance; scattered authorization (TD-REG-006); two competing commission configuration sources (`parties.commission_percent` vs `users.commission_config`) — the direct cause of P0-1b.

**Dead / duplicate / incomplete:** `CommissionShare.labCostMinor` deduction branch is dead code (P0-1a); `payables` "panel" referenced by the void refusal does not exist (P0-2); Google Drive backup destination declared but not connected; `local_agent` backup destination is interface-only; 3 TODO markers only; no fake/demo data in the running app beyond seeded starter services and categories.

**Performance (clinic scale):** lists are paginated (patients limit/offset, audit limit); polling every 10–60 s (Today board 20 s) is fine for a few devices; `ensureSchema()` runs DDL on each cold process (TD-REG-002) — a startup-time and lock-contention risk, not a steady-state one; the commission report re-allocates **all** invoices/payments of every patient touched in the period — acceptable now, worth watching past tens of thousands of invoices. No N+1 hotspot observed in the executed flows (21 screens loaded in ≈0.6–1.0 s each locally, networkidle).

---

## 14. Final verdict

- **SAFE_FOR_REAL_CLINIC_USE_NOW = NO**
- **SAFE_FOR_LIMITED_PILOT = YES** — reception, appointments, clinical records, patient payments/refunds, with rules R1–R6, **after** the backup/restore proof (P0-3).
- **REQUIRED_BEFORE_FULL_GO_LIVE** = P0-1 commission engine · P0-2 payable overpay guard + reversal · P0-3 proven off-site backup/restore + production schema preflight · P1-1 UI payment idempotency · P1-3 shift expected/discrepancy · P1-2 Reports Center · P1-4 audit gaps · P1-6 price authority · P1-5 importer + currency-aware opening balances (before migrating the old center's data).

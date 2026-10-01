import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SummaryTab } from "../components/patient/SummaryTab";
import { formatMoney } from "../lib/money";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.stubEnv("USE_LOCAL_DB", "true");
vi.stubEnv("NODE_ENV", "test");
vi.stubEnv("RAILWAY_PROJECT_ID", "");
const { ensureSchema, getPool, resetPoolForTesting, openShift, createPlan,
  recordPlanInstallment, recordPlanConsent, patientWorkflow } = await import("../lib/db");

beforeAll(async () => {
  await ensureSchema();
  await openShift({ openedBy: "operational-test", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 60_000);
afterAll(async () => { await resetPoolForTesting(); });

it("300 SAR agreement: paid 100 then 40 leaves 200 then 160 while current invoices are settled", async () => {
  const { rows: [patient] } = await getPool().query<{ id: number }>(
    "INSERT INTO patients (patient_number, full_name) VALUES ('OP-SAR-1', 'مريض تجريبي اتفاق') RETURNING id",
  );
  const planId = await createPlan({ patientId: patient.id, title: "تقويم", totalMinor: 30_000,
    baseCurrency: "SAR", startDate: "2026-10-01", note: null, createdBy: "operational-test",
    installments: [1, 2, 3].map((number) => ({ number, dueDate: `2026-${number + 9}-01`, amountMinor: 10_000 })),
  });
  expect(planId).toBeTruthy();
  const collect = (amountMinor: number, installmentNumber: number) => recordPlanInstallment({
    patientId: patient.id, planId: planId!, planTitle: "تقويم", installmentNumber,
    amountMinor, currency: "SAR", baseCurrency: "SAR", exchangeRate: 1,
    method: "cash", note: "اختبار", createdBy: "operational-test",
  });
  expect(await collect(10_000, 1)).toHaveProperty("paymentId");
  const first = await patientWorkflow(patient.id, "2026-10-01");
  expect(first.financial?.byCurrency.SAR).toMatchObject({ agreedMinor: 30_000,
    agreementPaidMinor: 10_000, agreementRemainingMinor: 20_000, balanceMinor: 0 });
  expect(first.financial?.byCurrency.YER.agreementRemainingMinor).toBe(0);
  const html = renderToStaticMarkup(createElement(SummaryTab, {
    summary: { ...first, canSeeFinancial: true }, patientId: patient.id,
    patientName: "مريض تجريبي", patientNumber: "OP-SAR-1", patientPhone: null, base: "YER",
    onVisitStarted: () => {}, onChanged: () => {}, onGoToTab: () => {},
  }));
  expect(html).toContain("المتبقي من الاتفاق");
  expect(html).toContain(formatMoney(20_000, "SAR"));
  expect(html).toContain("المستحق الحالي مسدّد");
  expect(html).not.toContain("الرصيد خالص");
  expect(first.activePlans[0].baseCurrency).toBe("SAR");
  expect(first.alerts.some((alert) => alert.kind === "overdue_installment")).toBe(false);
  expect(await collect(4_000, 2)).toHaveProperty("paymentId");
  const second = await patientWorkflow(patient.id, "2026-10-01");
  expect(second.financial?.byCurrency.SAR).toMatchObject({ agreementPaidMinor: 14_000,
    agreementRemainingMinor: 16_000, invoicedMinor: 14_000, paidMinor: 14_000, balanceMinor: 0 });
  // Collection never implies patient consent. A fixed agreement can then be consented explicitly.
  expect(second.activePlans[0].consentAt).toBeNull();
  expect(await recordPlanConsent({ planId: planId!, actor: "operational-test", note: "موافقة صريحة" })).toMatchObject({ ok: true, totalMinor: 30_000 });
  const consented = await patientWorkflow(patient.id, "2026-10-01");
  expect(consented.activePlans[0].consentAt).not.toBeNull();
  expect(consented.financial?.byCurrency.SAR).toMatchObject({ agreedMinor: 30_000, agreementRemainingMinor: 16_000 });
}, 30_000);

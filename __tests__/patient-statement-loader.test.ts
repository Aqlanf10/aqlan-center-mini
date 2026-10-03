import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ query: vi.fn(), session: vi.fn() }));
vi.mock("../lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/db")>(),
  ensureSchema: vi.fn(), listParties: vi.fn().mockResolvedValue([]), getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
import { buildReport, parseFilters } from "../lib/reports";
import { GET } from "../app/api/reports/route";

const query = new URLSearchParams({ report: "patient-statement", patientId: "17", preset: "custom",
  from: "2026-09-01", to: "2026-09-30", doctorId: "92", serviceId: "81", specialty: "endo",
  currency: "SAR", method: "transfer", receivedBy: "synthetic-filter" });
const invoiceRows = [
  { id: 1, patient_id: 17, date: "2026-08-20", total: "1000", discount: "100", base_currency: "YER", plan_id: null, categories: ["general"], doctor_ids: [1], items: ["YER before from"] },
  { id: 2, patient_id: 17, date: "2026-09-30", total: "2000", discount: "200", base_currency: "SAR", plan_id: null, categories: ["general"], doctor_ids: [1], items: ["SAR boundary"] },
  { id: 3, patient_id: 17, date: "2026-10-01", total: "9000", discount: "0", base_currency: "YER", plan_id: null, categories: ["general"], doctor_ids: [1], items: ["FUTURE"] },
];
const paymentRows = [
  { id: 1, patient_id: 17, date: "2026-08-21", kind: "payment", amount: "300", currency: "YER", base: "300", method: "cash", invoice_id: null, plan_id: null, opening_currency: "YER", created_by: "other", note: null, created_at: new Date("2026-08-21T10:00:00Z") },
  { id: 2, patient_id: 17, date: "2026-09-30", kind: "payment", amount: "400", currency: "SAR", base: "170000", method: "cash", invoice_id: null, plan_id: null, opening_currency: "SAR", created_by: "other", note: null, created_at: new Date("2026-09-30T10:00:00Z") },
];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ role: "reception", username: "synthetic", userId: 1 });
  mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes("AS today")) return { rows: [{ today: "2026-10-02" }] };
    if (sql.includes("FROM expenses")) return { rows: [] };
    if (sql.includes("FROM patients p")) {
      expect(params).toEqual(["Asia/Aden", 17, null]);
      return { rows: [{ id: 17, patient_number: "SYN-17", full_name: "Synthetic patient", phone: null,
        created_date: "2026-01-01", last_visit: "2026-10-02", status: "active" }] };
    }
    if (sql.includes("FROM invoices i") && sql.includes("AS categories")) {
      expect(params).toEqual(["Asia/Aden", [17]]);
      expect(sql.slice(sql.lastIndexOf("WHERE"))).toMatch(/i\.status <> 'cancelled' AND i\.patient_id = ANY\(\$2::int\[\]\)/);
      return { rows: invoiceRows };
    }
    if (sql.includes("FROM payments WHERE")) {
      expect(params).toEqual(["Asia/Aden", [17]]);
      expect(sql.slice(sql.lastIndexOf("WHERE"))).toBe("WHERE patient_id = ANY($2::int[])");
      return { rows: paymentRows };
    }
    if (sql.includes("FROM patient_opening_balances")) {
      expect(params).toEqual([[17]]);
      return { rows: [{ patient_id: 17, currency: "YER", as_of: "2026-01-01", amount: "100" }] };
    }
    if (sql.includes("FROM treatment_plans tp WHERE tp.patient_id")) return { rows: [] };
    if (sql.includes("SELECT id, patient_id, base_currency FROM invoices")) return { rows: invoiceRows };
    if (sql.includes("SELECT DISTINCT patient_id, doctor_id FROM visits")) return { rows: [] };
    if (sql.includes("SELECT it.invoice_id")) return { rows: [] };
    if (sql.includes("SELECT v.id, v.patient_id")) {
      expect(params).toEqual(["Asia/Aden", "2026-09-30", 17]);
      expect(sql).toContain("WHERE (v.arrived_at AT TIME ZONE $1)::date <= $2::date");
      return { rows: [{ id: 1, patient_id: 17, patient_name: "Synthetic patient", patient_number: "SYN-17", phone: null,
        date: "2026-08-15", arrived_at: new Date("2026-08-15T10:00:00Z"), called_at: null, seated_at: null,
        finished_at: null, status: "done", doctor_id: 1, invoice_id: null, appointment_id: null, chair: null, first_visit: true }] };
    }
    throw new Error(`Unexpected synthetic query: ${sql}`);
  });
});
function verifyResult(result: Awaited<ReturnType<typeof buildReport>>) {
  expect(result.rows).toHaveLength(5);
  expect(result.rows!.map((row) => row.currency)).toEqual(expect.arrayContaining(["YER", "SAR"]));
  expect(JSON.stringify(result.rows)).toContain("YER before from");
  expect(JSON.stringify(result.rows)).not.toContain("FUTURE");
  expect(result.kpis.find((item) => item.key === "balance")?.minor).toBe(700);
  expect(result.kpis.find((item) => item.key === "balance-SAR")?.minor).toBe(1400);
  expect(result.kpis.find((item) => item.key === "lastVisit")?.text).toBe("15/08/2026");
  expect(result.filtersLabel).toContain("جميع العملات");
}
describe("actual patient statement movement loader and report handler", () => {
  it("does not prefilter patient movements by inherited from/doctor/service/currency/method filters", async () => {
    verifyResult(await buildReport("patient-statement", parseFilters(query, "2026-10-02")));
  });
  it("preserves the same whole-patient contract through the existing authorized API handler", async () => {
    const response = await GET(new Request(`https://synthetic.invalid/api/reports?${query}`));
    expect(response.status).toBe(200);
    verifyResult((await response.json()).result);
  });
});

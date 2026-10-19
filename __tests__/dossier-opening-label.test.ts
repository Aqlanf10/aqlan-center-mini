import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { formatMoney } from "../lib/money";

const mocks = vi.hoisted(() => ({ session: vi.fn(), access: vi.fn(), patient: vi.fn(), chart: vi.fn(),
  ledger: vi.fn(), planCurrencies: vi.fn(), settings: vi.fn(), endo: vi.fn() }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/patient-access", () => ({ canAccessPatient: mocks.access }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("../lib/db")>(),
  getPatientFile: mocks.patient, patientChart: mocks.chart, patientLedger: mocks.ledger,
  patientPlanCurrencies: mocks.planCurrencies, getSettingsSafe: mocks.settings }));
vi.mock("@/lib/endodontics-db", () => ({ listPatientEndo: mocks.endo }));
vi.mock("@/components/PrintHeader", () => ({ PrintHeader: ({ title }: { title: string }) => createElement("h1", null, title) }));
vi.mock("@/components/PrintButton", () => ({ PrintButton: () => null }));
import DossierPage from "../app/print/dossier/[id]/page";



it("FIN007: opening principal must not be printed as invoices", async () => {
  mocks.session.mockResolvedValue({role:"admin",username:"synthetic",userId:1});
  mocks.access.mockResolvedValue(true);
  mocks.patient.mockResolvedValue({patient:{id:17,fullName:"Synthetic dossier",patientNumber:"SYN-DOSSIER",gender:"male",birthYear:1990,createdAt:"2026-01-01T00:00:00Z"},visits:[],appointments:[]});
  mocks.chart.mockResolvedValue({records:[],summary:{charted:0,caries:0,planned:0,completed:0,absent:0}});
  mocks.planCurrencies.mockResolvedValue(new Map()); mocks.settings.mockResolvedValue({}); mocks.endo.mockResolvedValue([]);
  mocks.ledger.mockResolvedValue({invoices:[],payments:[],openings:[{patientId:17,currency:"YER",amountMinor:1000,asOfDate:"2026-01-01"}]});
  const output=renderToStaticMarkup(await DossierPage({params:Promise.resolve({id:"17"})}));
  const text=output.replace(/<[^>]*>/g,"").replace(/\s+/g," ");
  expect(text).toContain(`الرصيد السابق: ${formatMoney(1000,"YER")}`);
  expect(text).toContain(`الرصيد المتبقي (الذمة): ${formatMoney(1000,"YER")}`);
  expect(text).toContain(`إجمالي الفواتير: ${formatMoney(0,"YER")}`);
});

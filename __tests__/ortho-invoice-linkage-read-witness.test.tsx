import type { ComponentProps, ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrthoPackageLink } from "../components/OrthoPackageLink";
import { projectTreatmentFinancialReferences, type TreatmentFinancialSnapshot } from "../lib/treatment-financial-context";

/** Read-contract witness against independently projected synthetic source edges.
 * It runs no DB writer/schema and claims no end-to-end writer execution or
 * patient finding. The original baseline witness is preserved outside this candidate.
 */
vi.mock("../lib/db", () => { throw new Error("This witness must never load a database module"); });
vi.mock("../components/SessionProvider", () => ({
  useSession: () => ({ username: "synthetic-ortho-admin", role: "admin", permissions: {} }),
}));

// Same keyed effect-lifetime model used by ortho-package-read-state.test.tsx.
const hooks = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, key: null as string | null,
  effects: new Map<number, { deps: readonly unknown[]; cleanup?: () => void }>(),
  pending: [] as (() => void)[],
}));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const effect = (callback: () => void | (() => void), deps: readonly unknown[]) => {
    const index = hooks.cursor++; const previous = hooks.effects.get(index);
    if (previous && deps.length === previous.deps.length && deps.every((value, at) => Object.is(value, previous.deps[at]))) return;
    previous?.cleanup?.();
    const entry = { deps, cleanup: undefined as (() => void) | undefined };
    hooks.effects.set(index, entry);
    hooks.pending.push(() => { entry.cleanup = callback() || undefined; });
  };
  return { ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      const values = hooks.values;
      return [values[index], (update: unknown) => { values[index] = typeof update === "function" ? update(values[index]) : update; }];
    },
    useRef: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect: effect, useLayoutEffect: effect,
  };
});

type Props = ComponentProps<typeof OrthoPackageLink>;
type Element = ReactElement<Record<string, unknown>>;
const IDs = { patient: 901, plan: 902, item: 903, clinicalCase: 904, ortho: 905, invoice: 906, line: 907 };
const defaults: Props = { patientId: IDs.patient, caseId: IDs.ortho, planId: null, canLink: true, onChanged: vi.fn() };
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const planResponse = (installments: { id: number }[] = []) => ({ plans: [{
  id: IDs.plan, patientId: IDs.patient, title: "Synthetic invoice-origin orthodontics",
  status: "active", installments,
}] });

/** The persisted edges created by the normal invoice writer plus a matching
 * Ortho intake bridge. ortho_cases.plan_id is intentionally absent/null; that
 * separate legacy package field is not the canonical item/case invoice edge.
 */
function invoiced(paidMinor = 0): TreatmentFinancialSnapshot {
  return {
    patientId: IDs.patient,
    plans: [{ id: IDs.plan, patientId: IDs.patient, currency: "YER", totalMinor: 300000,
      status: "active", billingMode: "per_procedure", hasInstallments: false }],
    items: [{ patientId: IDs.patient, planId: IDs.plan, planItemId: IDs.item,
      clinicalCaseId: IDs.clinicalCase, orthoCaseId: IDs.ortho, origin: "invoice",
      originInvoiceId: IDs.invoice, billedInvoiceId: IDs.invoice, billingStatus: "billed",
      financialReviewRequired: false, hasInvoiceLineage: true, hasLegacyLineage: false, legacyCoverageState: "none" }],
    invoices: [{ id: IDs.invoice, patientId: IDs.patient, planId: null, invoiceNumber: "SYNTH-ORTHO-906",
      currency: "YER", totalMinor: 300000, discountMinor: 0, status: paidMinor === 300000 ? "paid" : "open" }],
    lines: [{ id: IDs.line, invoiceId: IDs.invoice, planItemId: IDs.item,
      sourceType: "plan_item", sourceId: IDs.item, totalMinor: 300000 }],
    receipts: paidMinor ? [{ id: 908, patientId: IDs.patient, invoiceId: IDs.invoice, planId: null,
      openingCurrency: null, reversalOfId: null, currency: "YER", amountMinor: paidMinor,
      baseAmountMinor: paidMinor, exchangeRate: 1, kind: "payment" }] : [],
    legacyAgreements: [], openings: [],
  };
}
function render(overrides: Partial<Props> = {}): ReactNode {
  hooks.cursor = 0;
  const wrapper = OrthoPackageLink({ ...defaults, ...overrides });
  if (hooks.key !== (wrapper?.key ?? null)) {
    for (const entry of hooks.effects.values()) entry.cleanup?.();
    hooks.values = []; hooks.effects.clear(); hooks.pending = [];
    hooks.key = wrapper?.key == null ? null : String(wrapper.key);
  }
  if (!wrapper) return null;
  hooks.cursor = 0;
  const tree = (wrapper.type as (props: Props) => ReactNode)(wrapper.props);
  hooks.pending.splice(0).forEach(effect => effect());
  return tree;
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (node && typeof node === "object" && "props" in node) return text((node as Element).props.children as ReactNode);
  return "";
}
async function settle() { for (let i = 0; i < 40; i++) await Promise.resolve(); }
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.key = null; hooks.effects.clear(); hooks.pending = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url, init) => {
    if (init?.method && init.method !== "GET") throw new Error("Mutation forbidden in read-only witness");
    if (url === `/api/plans?patientId=${IDs.patient}`) return Response.json(planResponse());
    if (url === `/api/patients/${IDs.patient}/treatment-financial-context`) return Response.json(projectTreatmentFinancialReferences(invoiced()));
    throw new Error(`Unexpected read: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  for (const entry of hooks.effects.values()) entry.cleanup?.();
  vi.unstubAllGlobals();
});

describe("normal invoice-to-Ortho linkage read-contract witness", () => {
  it("canonical projection proves the exact invoice/item/case edge, not future-adjustment coverage", () => {
    const source = invoiced(); const before = JSON.stringify(source);
    const result = projectTreatmentFinancialReferences(source);
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({ patientId: IDs.patient, planId: IDs.plan,
      planItemId: IDs.item, clinicalCaseId: IDs.clinicalCase, orthoCaseId: IDs.ortho,
      invoiceIds: [IDs.invoice], packageCoverage: { state: "unspecified" } });
    expect(result.references[0].unresolvedReasons).not.toContain("financial_review_required");
    expect(result.references[0].unresolvedReasons).toContain("package_coverage_unspecified");
    expect(result.documents.map(document => document.invoiceId)).toEqual([IDs.invoice]);
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each([0, 120000, 300000])("does not let the optional old-plan field deny a valid invoice reference; paid=%i", async paidMinor => {
    const canonical = projectTreatmentFinancialReferences(invoiced(paidMinor));
    expect(canonical.references[0].invoiceIds).toEqual([IDs.invoice]);
    expect(canonical.accountPositions.YER.dueMinor).toBe(300000 - paidMinor);
    expect(canonical.references[0].packageCoverage.state).toBe("unspecified");
    render(); await settle(); const output = text(render());
    expect(output).not.toContain("لا اتفاق مالي مربوط بالحالة");
    expect(output).not.toContain("حتى تُربط الحالة باتفاق أقساط");
    expect(output).toContain("هذا الرابط ليس مطلوبًا للفاتورة أو الاتفاق السابق");
    expect(output).not.toContain("✓ رابط اتفاق أقساط قديم");
    expect(output).not.toContain("SYNTH-ORTHO-906");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`/api/plans?patientId=${IDs.patient}`]);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === undefined || init.method === "GET")).toBe(true);
  });

  it("a same-patient sibling case is not this case's financial reference", () => {
    const source = invoiced();
    source.items.push({ ...source.items[0], planItemId: 913, clinicalCaseId: 914, orthoCaseId: 915 });
    source.lines[0].totalMinor = 150000;
    source.lines.push({ ...source.lines[0], id: 917, planItemId: 913, sourceId: 913 });
    const selected = projectTreatmentFinancialReferences(source).references.filter(row => row.orthoCaseId === IDs.ortho);
    expect(selected.map(row => row.planItemId)).toEqual([IDs.item]);
    expect(selected[0].packageCoverage.state).toBe("unspecified");
  });

  it("preserves the distinct existing explicit installment-package path", async () => {
    fetchMock.mockResolvedValue(Response.json(planResponse([{ id: 918 }])));
    render({ planId: IDs.plan }); await settle();
    expect(text(render({ planId: IDs.plan }))).toContain("✓ رابط اتفاق أقساط قديم");
  });

  it("an unavailable read must remain unknown, never a new absence assertion", async () => {
    fetchMock.mockResolvedValue(Response.json({ message: "Synthetic failure" }, { status: 503 }));
    render(); await settle(); const output = text(render());
    expect(output).toContain("هذا لا يعني عدم وجود اتفاق أو أقساط");
    expect(output).not.toContain("لا اتفاق مالي مربوط بالحالة");
  });
});

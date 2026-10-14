import { describe, expect, it } from "vitest";
import type { Invoice, InvoiceItem } from "../lib/db";
import type { LineLink } from "../lib/invoice-linkage-db";
import {
  readInvoiceTemplateReceipt, readInvoiceCommandReceipt, type InvoiceTemplateReceiptExpectation, type InvoiceTemplateReceiptExpectedLine,
} from "../lib/invoice-template-receipt";

/** The canonical mapper emits every item field, including nullable lineage. */
interface InvoiceReceiptFixture extends Omit<Invoice, "items"> {
  items: Required<InvoiceItem>[];
  clinical: { planId: number | null; links: LineLink[] };
  replayed: boolean;
}

function fixture() {
  const owner = { patientId: 91 };
  const manual: InvoiceTemplateReceiptExpectedLine = {
    source: "manual", serviceId: null, doctorId: null, description: "Synthetic manual line", quantity: 2, unitPriceMinor: 99,
    toothCode: null, surfaces: null, kind: "financial", specialty: null, scheduled: false,
    planItem: { mode: "none" }, case: { mode: "none" },
  };
  const consultation: InvoiceTemplateReceiptExpectedLine = {
    source: "template", serviceId: 3, doctorId: 7, description: "Synthetic scheduled consultation", quantity: 1, unitPriceMinor: 5000,
    toothCode: null, surfaces: null, kind: "financial", specialty: null, scheduled: true,
    planItem: { mode: "new" }, case: { mode: "none" },
  };
  const clinical: InvoiceTemplateReceiptExpectedLine = {
    source: "template", serviceId: 1, doctorId: 7, description: "Synthetic root canal", quantity: 1, unitPriceMinor: 60000,
    toothCode: 36, surfaces: null, kind: "clinical", specialty: "endodontics", scheduled: true,
    planItem: { mode: "new" }, case: { mode: "new" },
  };
  const expected: InvoiceTemplateReceiptExpectation = {
    owner, patientId: 91, currency: "YER", discountMinor: 198, note: null, expectedPlanId: 77,
    lines: [manual, consultation, clinical],
  };
  const payload: InvoiceReceiptFixture = {
    id: 121, invoiceNumber: "INV-SYNTHETIC-121", patientId: 91, patientName: "Synthetic patient", status: "open",
    totalMinor: 65198, discountMinor: 198, baseCurrency: "YER", note: null, createdAt: "2026-10-11T00:00:00.000Z", replayed: false,
    items: [
      { id: 211, serviceId: null, doctorId: null, description: manual.description, quantity: 2, unitPriceMinor: 99, totalMinor: 198,
        planItemId: null, caseId: null, toothCode: null, surfaces: null, originInvoiceId: null, billingStatus: null, financialReviewRequired: false },
      { id: 212, serviceId: 3, doctorId: 7, description: consultation.description, quantity: 1, unitPriceMinor: 5000, totalMinor: 5000,
        planItemId: 81, caseId: null, toothCode: null, surfaces: null, originInvoiceId: 121, billingStatus: "billed", financialReviewRequired: false },
      { id: 213, serviceId: 1, doctorId: 7, description: clinical.description, quantity: 1, unitPriceMinor: 60000, totalMinor: 60000,
        planItemId: 82, caseId: 61, toothCode: 36, surfaces: null, originInvoiceId: 121, billingStatus: "billed", financialReviewRequired: false },
    ],
    clinical: { planId: 77, links: [
      { line: 0, kind: "financial", specialty: null, planItemId: null, planItemCreated: false, caseId: null, caseCreated: false },
      { line: 1, kind: "financial", specialty: null, planItemId: 81, planItemCreated: true, caseId: null, caseCreated: false, scheduled: true },
      { line: 2, kind: "clinical", specialty: "endodontics", planItemId: 82, planItemCreated: true, caseId: 61, caseCreated: true, scheduled: true },
    ] },
  };
  return { owner, expected, payload };
}

type Payload = ReturnType<typeof fixture>["payload"];
function rejected(change: (payload: Payload) => void) {
  const { owner, expected, payload } = fixture();
  change(payload);
  expect(readInvoiceTemplateReceipt(payload, expected, owner)).toBeNull();
}

describe("complete template invoice success acknowledgement", () => {
  it("requires complete ordinary financial invoice acknowledgement and exact saved repayment terms",()=>{
    const {owner,expected,payload}=fixture();
    const terms={mode:"installments" as const,installments:[{dueDate:"2026-10-12",amountMinor:198,kind:"installment" as const}]};
    const ordinary={...expected,discountMinor:0,expectedPlanId:null,lines:[expected.lines[0]],repaymentTerms:terms};
    const receipt={...payload,totalMinor:198,discountMinor:0,items:[payload.items[0]],clinical:{planId:null,links:[payload.clinical.links[0]]},repayment:{arrangementId:41,revisionId:51,version:1,terms}};
    expect(readInvoiceCommandReceipt(receipt,ordinary,owner)?.invoice.id).toBe(payload.id);
    expect(readInvoiceTemplateReceipt(receipt,ordinary,owner)).toBeNull();
    expect(readInvoiceCommandReceipt({...receipt,repayment:null},ordinary,owner)).toBeNull();
    expect(readInvoiceCommandReceipt({...receipt,repayment:{...receipt.repayment,terms:{mode:"full",installments:[]}}},ordinary,owner)).toBeNull();
    expect(readInvoiceCommandReceipt({...receipt,patientId:92},ordinary,owner)).toBeNull();
    expect(readInvoiceCommandReceipt({...receipt,items:[]},ordinary,owner)).toBeNull();
    expect(readInvoiceCommandReceipt(receipt,ordinary,{})).toBeNull();
  });
  it("accepts all manual and template rows, including financial scheduled work", () => {
    const { owner, expected, payload } = fixture();
    const accepted = readInvoiceTemplateReceipt(payload, expected, owner);
    expect(accepted).toEqual({ invoice: {
      id: payload.id, invoiceNumber: payload.invoiceNumber, patientId: 91, patientName: payload.patientName, status: "open",
      totalMinor: 65198, discountMinor: 198, baseCurrency: "YER", note: null, createdAt: payload.createdAt, items: payload.items,
    }, clinical: payload.clinical, replayed: false });
    expect(accepted?.clinical.links[1]).toMatchObject({ kind: "financial", scheduled: true, planItemId: 81, caseId: null });
    expect(accepted?.invoice).not.toBe(payload);
    expect(accepted?.invoice.items).not.toBe(payload.items);
    expect(accepted?.clinical.links).not.toBe(payload.clinical.links);
    // The canonical route has no echoed template ID, version or session schedule.
    expect(accepted).not.toHaveProperty("template");
  });

  it("accepts exact replay with creation flags cleared and no refreshed catalogue", () => {
    const { owner, expected, payload } = fixture();
    payload.replayed = true;
    payload.clinical.links.forEach((link) => { link.planItemCreated = false; link.caseCreated = false; });
    expect(readInvoiceTemplateReceipt(payload, expected, owner)?.replayed).toBe(true);
    payload.clinical.links[2].caseCreated = true;
    expect(readInvoiceTemplateReceipt(payload, expected, owner)).toBeNull();
  });

  it("rejects another patient, currency, chosen plan, or form-owner lifetime", () => {
    const { expected, payload } = fixture();
    expect(readInvoiceTemplateReceipt(payload, expected, { patientId: 91 })).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, expected, { patientId: 92 })).toBeNull();
    rejected((one) => { one.patientId = 92; });
    rejected((one) => { one.baseCurrency = "SAR"; });
    rejected((one) => { one.clinical.planId = 78; });
  });

  it("allows an initially unknown plan identity but requires the created template plan", () => {
    const { owner, expected, payload } = fixture();
    expect(readInvoiceTemplateReceipt(payload, { ...expected, expectedPlanId: null }, owner)?.clinical.planId).toBe(77);
    expect(readInvoiceTemplateReceipt({ ...payload, clinical: { ...payload.clinical, planId: null } }, expected, owner)).toBeNull();
  });

  it.each([null, [], {}, "saved", true, 121])("rejects a non-receipt: %j", (payload) => {
    const { owner, expected } = fixture();
    expect(readInvoiceTemplateReceipt(payload, expected, owner)).toBeNull();
  });

  it.each([null, {}, true, "links", [null], ["clinical"]])("rejects malformed clinical.links: %j", (links) => {
    const { owner, expected, payload } = fixture();
    expect(readInvoiceTemplateReceipt({ ...payload, clinical: { planId: 77, links } }, expected, owner)).toBeNull();
  });

  it("rejects absent clinical envelope, sparse lines, wrong counts, duplicates and reordered identities", () => {
    const { owner, expected, payload } = fixture();
    for (const clinical of [undefined, null, [], {}, { links: payload.clinical.links }]) {
      expect(readInvoiceTemplateReceipt({ ...payload, clinical }, expected, owner)).toBeNull();
    }
    const sparse = new Array(payload.items.length);
    expect(readInvoiceTemplateReceipt({ ...payload, items: sparse }, expected, owner)).toBeNull();
    rejected((one) => { one.items.pop(); });
    rejected((one) => { one.clinical.links.pop(); });
    rejected((one) => { one.clinical.links[2].line = 1; });
    rejected((one) => { one.clinical.links.reverse(); });
    rejected((one) => { one.items.reverse(); });
    rejected((one) => { one.items[2].id = one.items[1].id; });
    rejected((one) => { one.items[2].planItemId = 81; one.clinical.links[2].planItemId = 81; });
  });

  it("binds ordered service, provider, description, quantity, unit price, site and total", () => {
    rejected((one) => { one.items[2].serviceId = 2; });
    rejected((one) => { one.items[2].doctorId = 8; });
    rejected((one) => { one.items[2].description = "Different submitted work"; });
    rejected((one) => { one.items[2].quantity = 2; });
    rejected((one) => { one.items[2].unitPriceMinor = 60001; });
    rejected((one) => { one.items[2].toothCode = 11; });
    rejected((one) => { Object.assign(one.items[2], { surfaces: "MO" }); });
    rejected((one) => { one.items[2].totalMinor = 60001; });
    rejected((one) => { one.totalMinor += 1; });
    rejected((one) => { one.discountMinor += 1; });
    rejected((one) => { Object.assign(one, { note: "Different command" }); });
  });

  it("rejects valid-looking self-consistent amounts belonging to different submitted work", () => {
    rejected((one) => { one.items[2].unitPriceMinor = 61000; one.items[2].totalMinor = 61000; one.totalMinor = 66198; });
    rejected((one) => { one.items[0].quantity = 3; one.items[0].totalMinor = 297; one.totalMinor = 65297; });
  });

  it("preserves currency precision, zero amounts and the canonical discount cap", () => {
    const { owner, expected, payload } = fixture();
    expect(readInvoiceTemplateReceipt({ ...payload, baseCurrency: "USD" }, { ...expected, currency: "USD" }, owner)?.invoice.baseCurrency).toBe("USD");
    expect(readInvoiceTemplateReceipt({ ...payload, discountMinor: payload.totalMinor },
      { ...expected, discountMinor: payload.totalMinor + 100 }, owner)?.invoice.discountMinor).toBe(payload.totalMinor);
    const lines = expected.lines.map((line) => ({ ...line, unitPriceMinor: 0 }));
    payload.items.forEach((item) => { item.unitPriceMinor = 0; item.totalMinor = 0; });
    payload.totalMinor = 0;
    payload.discountMinor = 0;
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)?.invoice.totalMinor).toBe(0);
  });

  it("rejects unsafe arithmetic, coerced fields and noncanonical timestamps", () => {
    rejected((one) => { one.totalMinor = Number.NaN; });
    rejected((one) => { one.items[0].id = -1; });
    rejected((one) => { one.items[0].id = 2_147_483_648; });
    rejected((one) => { one.createdAt = "yesterday"; });
    rejected((one) => { one.createdAt = "2026-02-30T00:00:00.000Z"; });
    rejected((one) => { Object.assign(one, { replayed: "false" }); });
    rejected((one) => { Object.assign(one.items[0], { quantity: "2" }); });
    rejected((one) => { Object.assign(one.clinical.links[2], { caseCreated: "true" }); });
    const { owner, expected, payload } = fixture();
    const lines = expected.lines.map((line, index) => index === 0 ? { ...line, unitPriceMinor: Number.MAX_SAFE_INTEGER } : line);
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)).toBeNull();
  });

  it("rejects incomplete or invalid retained expectations without throwing", () => {
    const { owner, expected, payload } = fixture();
    const sparse = new Array<InvoiceTemplateReceiptExpectedLine>(3);
    sparse[2] = expected.lines[2];
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: sparse }, owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: [] }, owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, { ...expected, patientId: 0 }, owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, { ...expected, discountMinor: -1 }, owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: expected.lines.map((line) => ({ ...line, source: "manual" })) }, owner)).toBeNull();
  });

  it("rejects missing canonical item DTO fields rather than defaulting lineage to null", () => {
    for (const field of ["serviceId", "doctorId", "planItemId", "caseId", "toothCode", "surfaces", "originInvoiceId", "billingStatus", "financialReviewRequired"]) {
      rejected((one) => { Reflect.deleteProperty(one.items[1], field); });
    }
    rejected((one) => { Reflect.deleteProperty(one, "patientName"); });
    rejected((one) => { Reflect.deleteProperty(one, "replayed"); });
  });

  it("rejects changed or contradictory item/link identity and manufactured specialty", () => {
    rejected((one) => { one.clinical.links[2].planItemId = 83; });
    rejected((one) => { one.clinical.links[2].caseId = 62; });
    rejected((one) => { one.clinical.links[2].specialty = "orthodontics"; });
    rejected((one) => { one.clinical.links[2].kind = "financial"; });
    rejected((one) => { one.clinical.links[2].scheduled = false; });
    rejected((one) => { one.clinical.links[1].scheduled = false; });
    rejected((one) => { one.clinical.links[1].kind = "clinical"; one.clinical.links[1].specialty = "consultation"; });
    rejected((one) => { one.items[1].caseId = 62; one.clinical.links[1].caseId = 62; });
    rejected((one) => { one.items[1].originInvoiceId = 122; });
    rejected((one) => { one.clinical.links[2].planItemCreated = false; });
    rejected((one) => { one.clinical.links[2].caseCreated = false; });
    rejected((one) => { one.clinical.links[0].caseCreated = true; });
  });

  it("accepts provider-unresolved work without inventing financial clearance", () => {
    const { owner, expected, payload } = fixture();
    const lines = expected.lines.map((line) => ({ ...line, doctorId: null }));
    payload.items.slice(1).forEach((item) => { item.doctorId = null; item.billingStatus = "needs_financial_review"; item.financialReviewRequired = true; });
    const accepted = readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner);
    expect(accepted?.invoice.items[1]).toMatchObject({ doctorId: null, billingStatus: "needs_financial_review", financialReviewRequired: true });
    payload.items[1].billingStatus = "billed";
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)).toBeNull();
    payload.items[1].financialReviewRequired = false;
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)).toBeNull();
    payload.items[1].billingStatus = "needs_financial_review";
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)).toBeNull();
  });

  it("accepts reused manual work beside a template and binds its selected identities", () => {
    const { owner, expected, payload } = fixture();
    const manual: InvoiceTemplateReceiptExpectedLine = { ...expected.lines[2], source: "manual", doctorId: null,
      planItem: { mode: "existing", id: 82 }, case: { mode: "existing", id: 61 } };
    const lines = [expected.lines[0], expected.lines[1], manual];
    payload.items[2].originInvoiceId = null;
    payload.clinical.links[2].planItemCreated = false;
    payload.clinical.links[2].caseCreated = false;
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)?.invoice.items[2].doctorId).toBe(7);
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: [lines[0], lines[1], { ...manual, doctorId: 8 }] }, owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: [lines[0], lines[1], { ...manual, planItem: { mode: "existing", id: 83 } }] }, owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: [lines[0], lines[1], { ...manual, case: { mode: "existing", id: 62 } }] }, owner)).toBeNull();
  });

  it("preserves one newly created shared case across distinct template plan items and replay", () => {
    const { owner, expected, payload } = fixture();
    const lines: InvoiceTemplateReceiptExpectedLine[] = [expected.lines[0], expected.lines[1],
      { ...expected.lines[2], specialty: "prosthodontics" }, { ...expected.lines[2], specialty: "prosthodontics", toothCode: 35 }];
    payload.clinical.links[2].specialty = "prosthodontics";
    payload.items.push({ ...payload.items[2], id: 214, planItemId: 83, toothCode: 35 });
    payload.clinical.links.push({ ...payload.clinical.links[2], line: 3, planItemId: 83, caseCreated: false });
    payload.totalMinor += 60000;
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)?.clinical.links.filter((line) => line.caseCreated)).toHaveLength(1);
    payload.clinical.links[3].caseCreated = true;
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)).toBeNull();
    payload.replayed = true;
    payload.clinical.links.forEach((link) => { link.planItemCreated = false; link.caseCreated = false; });
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)?.clinical.links[3].caseId).toBe(61);
  });

  it("preserves the exact case on a reused manual restorative item beside generated template work", () => {
    const { owner, expected, payload } = fixture();
    // Canonical preview.case is none for restorative work. The builder retains
    // this ID from the accepted matching item candidate's clinicalCaseId.
    const manual: InvoiceTemplateReceiptExpectedLine = { ...expected.lines[2], source: "manual", specialty: "restorative",
      planItem: { mode: "existing", id: 82 }, case: { mode: "existing", id: 61 } };
    const lines = [expected.lines[0], expected.lines[1], manual];
    payload.items[2].originInvoiceId = null;
    Object.assign(payload.clinical.links[2], { specialty: "restorative", planItemCreated: false, caseCreated: false });
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)?.clinical.links[2])
      .toMatchObject({ planItemId: 82, caseId: 61, caseCreated: false });
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: [lines[0], lines[1], { ...manual, case: { mode: "existing", id: 62 } }] }, owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: [lines[0], lines[1], { ...manual, case: { mode: "none" } }] }, owner)).toBeNull();
    payload.replayed = true;
    payload.clinical.links.forEach((link) => { link.planItemCreated = false; link.caseCreated = false; });
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)?.clinical.links[2].caseId).toBe(61);
    payload.clinical.links[2].caseCreated = true;
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)).toBeNull();
  });

  it("does not authorize a new restorative case or an inherited case on a generated template row", () => {
    const { owner, expected, payload } = fixture();
    const line: InvoiceTemplateReceiptExpectedLine = { ...expected.lines[2], specialty: "restorative", case: { mode: "existing", id: 61 } };
    Object.assign(payload.clinical.links[2], { specialty: "restorative", caseCreated: false });
    const withLine = (last: InvoiceTemplateReceiptExpectedLine) => ({ ...expected, lines: [expected.lines[0], expected.lines[1], last] });
    expect(readInvoiceTemplateReceipt(payload, withLine(line), owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, withLine({ ...line, source: "manual" }), owner)).toBeNull();
    expect(readInvoiceTemplateReceipt(payload, withLine({ ...line, source: "manual", planItem: { mode: "existing", id: 82 }, case: { mode: "new" } }), owner)).toBeNull();
  });

  it("accepts a template restorative line without inventing a case", () => {
    const { owner, expected, payload } = fixture();
    const lines: InvoiceTemplateReceiptExpectedLine[] = [...expected.lines.slice(0, 2),
      { ...expected.lines[2], specialty: "restorative", surfaces: "MO", case: { mode: "none" } }];
    Object.assign(payload.items[2], { caseId: null, surfaces: "MO" });
    Object.assign(payload.clinical.links[2], { specialty: "restorative", caseId: null, caseCreated: false });
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)?.clinical.links[2].caseId).toBeNull();
  });

  it("accepts the canonical orthodontic bridge and refuses a bridge with another specialty", () => {
    const { owner, expected, payload } = fixture();
    const line: InvoiceTemplateReceiptExpectedLine = { ...expected.lines[2], specialty: "orthodontics", toothCode: null, case: { mode: "bridge" } };
    const lines = [expected.lines[0], expected.lines[1], line];
    payload.items[2].toothCode = null;
    payload.clinical.links[2].specialty = "orthodontics";
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines }, owner)?.clinical.links[2].caseCreated).toBe(true);
    expect(readInvoiceTemplateReceipt(payload, { ...expected, lines: [lines[0], lines[1], { ...line, specialty: "endodontics" }] }, owner)).toBeNull();
  });

  it("rejects inherited payloads and drops unrelated response extras from accepted values", () => {
    const { owner, expected, payload } = fixture();
    expect(readInvoiceTemplateReceipt(Object.create(payload), expected, owner)).toBeNull();
    const inheritedItem = Object.create(payload.items[0]);
    expect(readInvoiceTemplateReceipt({ ...payload, items: [inheritedItem, ...payload.items.slice(1)] }, expected, owner)).toBeNull();
    const accepted = readInvoiceTemplateReceipt({ ...payload, untrusted: "ignored", clinical: { ...payload.clinical, extra: [] } }, expected, owner);
    expect(accepted).not.toBeNull();
    expect(accepted?.invoice).not.toHaveProperty("untrusted");
    expect(accepted?.clinical).not.toHaveProperty("extra");
  });
});

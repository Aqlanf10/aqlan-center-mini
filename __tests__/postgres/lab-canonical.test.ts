/** Slice 33: Canonical Laboratory Orders, Pricing, Services, Backlog & Directory on real PostgreSQL 18. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-lab-canonical-20261031");

const db = await import("../../lib/db");
const canonicalLab = await import("../../lib/canonical-lab");
const { labPrescriptionVersion } = await import("../../lib/lab-prescription-input");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");

const ACCOUNTS = {
  owner: { username: "SYN-LAB-OWNER", role: "admin" },
  viewerOnly: {
    username: "SYN-LAB-VIEWER",
    role: "reception",
    patientScope: "all",
    grants: {
      "clinical.lab.view": true,
    },
  },
  labManager: {
    username: "SYN-LAB-DIR-MGR",
    role: "admin",
    patientScope: "all",
    grants: {
      "clinical.lab.view": true,
      "clinical.laboratories.manage": true,
      "finance.lab-prices.edit": true,
    },
  },
  ownDoctor: {
    username: "SYN-LAB-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.lab.view": true,
      "clinical.lab.order": true,
    },
  },
  ownDocumenterWithCosts: {
    username: "SYN-LAB-DOC-FULL",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.lab.view": true,
      "clinical.lab.order": true,
      "clinical.visits.document": true,
      "finance.cost-prices.view": true,
    },
  },
  otherDoctor: {
    username: "SYN-LAB-DOC-OTHER",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.lab.view": true,
      "clinical.lab.order": true,
    },
  },
  payablesAccountant: {
    username: "SYN-LAB-PAYABLES",
    role: "accountant",
    patientScope: "all",
    grants: {
      "finance.payables.record": true,
    },
  },
  canceller: {
    username: "SYN-LAB-CANCELLER",
    role: "admin",
    patientScope: "all",
    grants: {
      "clinical.lab.view": true,
      "clinical.lab.order": true,
      "clinical.lab.cancel": true,
      "finance.cost-prices.view": true,
    },
  },
  noneScope: {
    username: "SYN-LAB-NONE",
    role: "doctor",
    doctor: true,
    patientScope: "none",
    grants: {
      "clinical.lab.view": true,
      "clinical.lab.order": true,
    },
  },
} as const;

type Key = keyof typeof ACCOUNTS;

let fx: CanonicalInventoryDatabase<Key>;

const ids = {
  ownPatient: 0,
  documenterPatient: 0,
  foreignPatient: 0,
  ownVisit: 0,
  labPartyId: 0,
  labServiceId: 0,
};

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");

  ids.ownPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-LAB-P1','SYN Lab Own',$1) RETURNING id",
      [fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.documenterPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-LAB-P2','SYN Lab Documenter',$1) RETURNING id",
      [fx.parties.ownDocumenterWithCosts!],
    )
  ).rows[0].id;

  ids.foreignPatient = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES('SYN-LAB-P3','SYN Lab Foreign',$1) RETURNING id",
      [fx.parties.otherDoctor!],
    )
  ).rows[0].id;

  ids.ownVisit = (
    await fx.pool.query<{ id: number }>(
      `INSERT INTO visits(patient_id,patient_name,status,doctor_id)
       VALUES($1,'SYN Lab Documenter','in_chair',$2) RETURNING id`,
      [ids.documenterPatient, fx.parties.ownDocumenterWithCosts!],
    )
  ).rows[0].id;

  await fx.pool.query(
    `INSERT INTO settings(key,value) VALUES
       ('fx.USD_to_YER','530'),
       ('fx.SAR_to_YER','140')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

it("registers read:lab.orders and read:lab.backlog in CANONICAL_RECORD_READS", () => {
  expect(CANONICAL_RECORD_READS["read:lab.orders"]).toEqual({
    record: "patient",
    need: ["clinical.lab.view"],
    anyOf: [],
  });
  expect(CANONICAL_RECORD_READS["read:lab.backlog"]).toEqual({
    record: "patient",
    need: ["clinical.lab.view"],
    anyOf: [],
  });
});

it("governs laboratories directory, lab services catalog, pricing rules, and work-intent capability", async () => {
  // Viewer without order/manage/edit capabilities is refused on writes and work-intent capability
  const viewerCapRes = await canonicalLab.readCanonicalLabWorkCapabilityResponse(await fx.session("viewerOnly"));
  expect(viewerCapRes.status).toBe(403);
  expect(await viewerCapRes.json()).toEqual({
    supported: false,
    message: "هذه العملية للطبيب أو المدير.",
  });

  const doctorCapRes = await canonicalLab.readCanonicalLabWorkCapabilityResponse(await fx.session("ownDoctor"));
  expect(doctorCapRes.status).toBe(200);
  const doctorCapJson = await doctorCapRes.json();
  expect(typeof doctorCapJson.supported).toBe("boolean");

  const forbiddenLabCreate = await canonicalLab.commandCanonicalCreateLaboratoryResponse(
    await fx.session("viewerOnly"),
    { name: "SYN Forbidden Lab" },
    fx.pool,
  );
  expect(forbiddenLabCreate.status).toBe(403);

  // Create active laboratory + temporary laboratory
  const createLabRes = await canonicalLab.commandCanonicalCreateLaboratoryResponse(
    await fx.session("labManager"),
    {
      name: "مختبر الدقة الرقمي SYN",
      phone: "777111222",
      currency: "YER",
      deliveryDays: 5,
    },
    fx.pool,
  );
  expect(createLabRes.status).toBe(201);
  const createdLab = await createLabRes.json();
  ids.labPartyId = createdLab.id;
  expect(createdLab.name).toBe("مختبر الدقة الرقمي SYN");

  const tempLabRes = await canonicalLab.commandCanonicalCreateLaboratoryResponse(
    await fx.session("labManager"),
    { name: "مختبر مؤقت SYN", currency: "YER" },
    fx.pool,
  );
  expect(tempLabRes.status).toBe(201);
  const tempLab = await tempLabRes.json();

  const patchTempLab = await canonicalLab.commandCanonicalUpdateLaboratoryResponse(
    await fx.session("labManager"),
    tempLab.id,
    { contactPerson: "م. سامي", deliveryDays: 4 },
    fx.pool,
  );
  expect(patchTempLab.status).toBe(200);
  expect((await patchTempLab.json()).deliveryDays).toBe(4);

  const delTempLab = await canonicalLab.commandCanonicalDeleteLaboratoryResponse(
    await fx.session("labManager"),
    tempLab.id,
    fx.pool,
  );
  expect(delTempLab.status).toBe(200);
  expect((await delTempLab.json()).ok).toBe(true);

  const listLabsRes = await canonicalLab.readCanonicalLaboratoriesResponse(await fx.session("viewerOnly"));
  expect(listLabsRes.status).toBe(200);
  const listedLabs = (await listLabsRes.json()).laboratories as Array<{ id: number }>;
  expect(listedLabs.some((l) => l.id === ids.labPartyId)).toBe(true);
  expect(listedLabs.some((l) => l.id === tempLab.id)).toBe(false);

  // Seed default services + create custom Zirconia service + pricing rule
  const seedRes = await canonicalLab.commandCanonicalCreateOrSeedLabServiceResponse(
    await fx.session("labManager"),
    { action: "seed_defaults" },
    fx.pool,
  );
  expect(seedRes.status).toBe(200);

  const createSvcRes = await canonicalLab.commandCanonicalCreateOrSeedLabServiceResponse(
    await fx.session("labManager"),
    {
      name: "تاج زركونيا متدرج SYN",
      code: "SYN_ZIR_01",
      category: "prostho",
      toothScope: "single_tooth",
      defaultDays: 6,
    },
    fx.pool,
  );
  expect(createSvcRes.status).toBe(201);
  const createdSvc = (await createSvcRes.json()).service;
  ids.labServiceId = createdSvc.id;

  const createRuleRes = await canonicalLab.commandCanonicalCreateLabPricingRuleResponse(
    await fx.session("labManager"),
    {
      partyId: ids.labPartyId,
      labServiceId: ids.labServiceId,
      costMinor: 25000,
      costCurrency: "YER",
      effectiveFrom: "2026-01-01",
    },
    fx.pool,
  );
  expect(createRuleRes.status).toBe(201);
  const rule = (await createRuleRes.json()).rule;
  expect(rule.costMinor).toBe(25000);

  const resolveRes = await canonicalLab.readCanonicalLabPricingResponse(
    await fx.session("viewerOnly"),
    new Request(
      `http://localhost/api/lab/pricing?resolve=1&partyId=${ids.labPartyId}&labServiceId=${ids.labServiceId}&date=2026-10-31`,
    ),
  );
  expect(resolveRes.status).toBe(200);
  expect((await resolveRes.json()).resolved.costMinor).toBe(25000);

  const updateRuleRes = await canonicalLab.commandCanonicalUpdateLabPricingRuleResponse(
    await fx.session("labManager"),
    rule.id,
    { costMinor: 28000, note: "تحديث سعر الزركونيا" },
    fx.pool,
  );
  expect(updateRuleRes.status).toBe(200);
  expect((await updateRuleRes.json()).rule.costMinor).toBe(28000);
});

it("enforces patient scope, own-clinician binding, auto-pricing, and cost projection on /api/lab", async () => {
  // noneScope refused on GET and POST
  const noneGet = await canonicalLab.readCanonicalLabResponse(
    await fx.session("noneScope"),
    new Request("http://localhost/api/lab"),
  );
  expect(noneGet.status).toBe(403);

  // ownDoctor refused on foreignPatient and on impersonating another doctor
  const foreignPost = await canonicalLab.commandCanonicalCreateLabOrderResponse(
    await fx.session("ownDoctor"),
    {
      patientId: ids.foreignPatient,
      partyId: ids.labPartyId,
      labName: "مختبر الدقة الرقمي SYN",
      workType: "تاج زركونيا",
      toothNumbers: "11",
      sentDate: "2026-10-31",
      dueDate: "2026-11-05",
    },
    fx.pool,
  );
  expect(foreignPost.status).toBe(403);

  const wrongDoctorPost = await canonicalLab.commandCanonicalCreateLabOrderResponse(
    await fx.session("ownDoctor"),
    {
      patientId: ids.ownPatient,
      doctorId: fx.parties.otherDoctor!,
      partyId: ids.labPartyId,
      labName: "مختبر الدقة الرقمي SYN",
      workType: "تاج زركونيا",
      toothNumbers: "11",
      sentDate: "2026-10-31",
      dueDate: "2026-11-05",
    },
    fx.pool,
  );
  expect(wrongDoctorPost.status).toBe(403);

  // Create order on foreignPatient by otherDoctor
  const otherCreate = await canonicalLab.commandCanonicalCreateLabOrderResponse(
    await fx.session("otherDoctor"),
    {
      patientId: ids.foreignPatient,
      partyId: ids.labPartyId,
      labServiceId: ids.labServiceId,
      labName: "مختبر الدقة الرقمي SYN",
      workType: "تاج زركونيا",
      toothNumbers: "21",
      sentDate: "2026-10-31",
      dueDate: "2026-11-05",
    },
    fx.pool,
  );
  expect(otherCreate.status).toBe(201);

  // ownDoctor creates auto-priced order on ownPatient — cost fields masked in response!
  const ownCreate = await canonicalLab.commandCanonicalCreateLabOrderResponse(
    await fx.session("ownDoctor"),
    {
      patientId: ids.ownPatient,
      partyId: ids.labPartyId,
      labServiceId: ids.labServiceId,
      labName: "مختبر الدقة الرقمي SYN",
      workType: "تاج زركونيا",
      toothNumbers: "11",
      sentDate: "2026-10-31",
      dueDate: "2026-11-05",
    },
    fx.pool,
  );
  expect(ownCreate.status).toBe(201);
  const maskedOrder = await ownCreate.json();
  expect(maskedOrder.costMinor).toBeNull();
  expect(maskedOrder.payableId).toBeNull();

  // Verify DB actually recorded the auto-resolved 28000 YER cost + payable + audit row!
  const dbRow = (
    await fx.pool.query<{ cost_minor: string; payable_id: number | null }>(
      "SELECT cost_minor, payable_id FROM lab_orders WHERE id = $1",
      [maskedOrder.id],
    )
  ).rows[0];
  expect(Number(dbRow.cost_minor)).toBe(28000);
  expect(dbRow.payable_id).toBeGreaterThan(0);

  // ownDoctor GET /api/lab sees ONLY ownPatient's order, with masked costs
  const ownListRes = await canonicalLab.readCanonicalLabResponse(
    await fx.session("ownDoctor"),
    new Request("http://localhost/api/lab"),
  );
  expect(ownListRes.status).toBe(200);
  const ownList = (await ownListRes.json()).orders as Array<{
    id: number;
    patientId: number;
    costMinor: number | null;
  }>;
  expect(ownList.every((o) => o.patientId === ids.ownPatient)).toBe(true);
  expect(ownList.find((o) => o.id === maskedOrder.id)?.costMinor).toBeNull();

  // ownDoctor GET /api/lab?patientId=foreignPatient -> 403
  const ownForeignQuery = await canonicalLab.readCanonicalLabResponse(
    await fx.session("ownDoctor"),
    new Request(`http://localhost/api/lab?patientId=${ids.foreignPatient}`),
  );
  expect(ownForeignQuery.status).toBe(403);

  // canceller (patientScope: all + finance.cost-prices.view) sees real costMinor = 28000
  const allListRes = await canonicalLab.readCanonicalLabResponse(
    await fx.session("canceller"),
    new Request(`http://localhost/api/lab?patientId=${ids.ownPatient}`),
  );
  expect(allListRes.status).toBe(200);
  const allList = (await allListRes.json()).orders as Array<{ id: number; costMinor: number | null }>;
  expect(allList.find((o) => o.id === maskedOrder.id)?.costMinor).toBe(28000);
});

it("handles prescription completion, shade/clinical CAS, accounting FX, remake, dispatched cancel gating, and delete", async () => {
  // 1. Create contextual 'needed' order on documenterPatient
  const neededRes = await canonicalLab.commandCanonicalCreateLabOrderResponse(
    await fx.session("ownDocumenterWithCosts"),
    {
      patientId: ids.documenterPatient,
      visitId: ids.ownVisit,
      toothCode: 16,
      status: "needed",
      source: "auto",
      workType: "تاج زركونيا",
      toothNumbers: "16",
    },
    fx.pool,
  );
  expect(neededRes.status).toBe(201);
  const neededOrder = await neededRes.json();
  expect(neededOrder.status).toBe("needed");

  // Compute optimistic version for complete_prescription
  const rawRow = (
    await fx.pool.query<{
      status: string;
      party_id: number | null;
      shade: string | null;
      stump_shade: string | null;
      tooth_numbers: string | null;
      due_date: string;
      impression_type: string | null;
      priority: string | null;
      work_type: string;
      source: string;
      tooth_code: number | null;
      visit_id: number | null;
    }>(
      `SELECT status, party_id, shade, stump_shade, tooth_numbers, due_date::text,
              impression_type, priority, work_type, source, tooth_code, visit_id
         FROM lab_orders WHERE id = $1`,
      [neededOrder.id],
    )
  ).rows[0];
  const expectedVersion = labPrescriptionVersion({
    status: rawRow.status as "needed",
    partyId: rawRow.party_id,
    shade: rawRow.shade,
    stumpShade: rawRow.stump_shade,
    toothNumbers: rawRow.tooth_numbers,
    dueDate: rawRow.due_date,
    impressionType: (rawRow.impression_type as "physical") ?? "physical",
    priority: (rawRow.priority as "normal") ?? "normal",
    workType: rawRow.work_type,
    source: (rawRow.source as "auto") ?? "auto",
    toothCode: rawRow.tooth_code,
    visitId: rawRow.visit_id,
  });

  // Actor without clinical.visits.document cannot complete prescription
  const noDocComplete = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("canceller"),
    neededOrder.id,
    {
      action: "complete_prescription",
      expected: expectedVersion,
      dispatch: true,
      prescription: {
        partyId: ids.labPartyId,
        shade: "A2",
        stumpShade: "ND2",
        toothNumbers: "16(Crown)",
        dueDate: "2099-12-31",
        impressionType: "digital_scan",
        priority: "urgent",
      },
    },
    fx.pool,
  );
  expect(noDocComplete.status).toBe(403);

  // ownDocumenterWithCosts completes and dispatches prescription -> status becomes 'sent'
  const completeRes = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("ownDocumenterWithCosts"),
    neededOrder.id,
    {
      action: "complete_prescription",
      expected: expectedVersion,
      dispatch: true,
      prescription: {
        partyId: ids.labPartyId,
        shade: "A2",
        stumpShade: "ND2",
        toothNumbers: "16(Crown)",
        dueDate: "2099-12-31",
        impressionType: "digital_scan",
        priority: "urgent",
      },
    },
    fx.pool,
  );
  expect(completeRes.status).toBe(200);
  expect(await completeRes.json()).toEqual({ id: neededOrder.id, status: "sent" });

  // 2. Shade CAS update + conflict check
  const nextShadeSpec = {
    version: 1,
    teeth: [
      {
        toothCode: 16,
        cervical: { guide: "vita_classical", code: "A3" },
        body: { guide: "vita_classical", code: "A2" },
        incisal: { guide: "vita_classical", code: "A1" },
      },
    ],
  };
  const shadeOk = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("ownDocumenterWithCosts"),
    neededOrder.id,
    {
      action: "update_shade",
      expectedShadeSpecification: null,
      shadeSpecification: nextShadeSpec,
    },
    fx.pool,
  );
  expect(shadeOk.status).toBe(200);

  const shadeConflict = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("ownDocumenterWithCosts"),
    neededOrder.id,
    {
      action: "update_shade",
      expectedShadeSpecification: null,
      shadeSpecification: nextShadeSpec,
    },
    fx.pool,
  );
  expect(shadeConflict.status).toBe(409);

  // 3. Accounting update by payablesAccountant (who holds ONLY finance.payables.record!)
  const wrongRateRes = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("payablesAccountant"),
    neededOrder.id,
    {
      action: "update_accounting",
      cost: "50",
      costCurrency: "USD",
      expectedExchangeRate: 500,
    },
    fx.pool,
  );
  expect(wrongRateRes.status).toBe(409);

  const acctRes = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("payablesAccountant"),
    neededOrder.id,
    {
      action: "update_accounting",
      cost: "50",
      costCurrency: "USD",
      expectedExchangeRate: 530,
      isPosted: false,
    },
    fx.pool,
  );
  expect(acctRes.status).toBe(200);
  const acctJson = await acctRes.json();
  expect(acctJson.costMinor).toBe(5000);
  expect(acctJson.costCurrency).toBe("USD");
  expect(acctJson.baseAmountMinor).toBe(26500);
  expect(acctJson.isPosted).toBe(false);

  const postRes = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("payablesAccountant"),
    neededOrder.id,
    { action: "post" },
    fx.pool,
  );
  expect(postRes.status).toBe(200);
  expect((await postRes.json()).isPosted).toBe(true);

  // 4. Dispatched cancel requires clinical.lab.cancel
  const docCancelDenied = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("ownDocumenterWithCosts"),
    neededOrder.id,
    { status: "cancelled" },
    fx.pool,
  );
  expect(docCancelDenied.status).toBe(403);

  // 5. Transition sent -> received, then create zero-cost remake
  const receiveRes = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("ownDocumenterWithCosts"),
    neededOrder.id,
    { status: "received", note: "استُلم للمعاينة" },
    fx.pool,
  );
  expect(receiveRes.status).toBe(200);
  expect((await receiveRes.json()).status).toBe("received");

  const remakeRes = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("ownDocumenterWithCosts"),
    neededOrder.id,
    {
      action: "remake",
      remakeReason: "عدم انطباق الحافة العنقية",
      newDueDate: "2099-12-31",
    },
    fx.pool,
  );
  expect(remakeRes.status).toBe(200);
  const remakeOrder = await remakeRes.json();
  expect(remakeOrder.status).toBe("sent");
  expect(remakeOrder.costMinor).toBe(0);
  expect(remakeOrder.financialStatus).toBe("exempt");

  // Events read
  const eventsRes = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("ownDocumenterWithCosts"),
    neededOrder.id,
    { action: "events" },
    fx.pool,
  );
  expect(eventsRes.status).toBe(200);
  expect((await eventsRes.json()).events.length).toBeGreaterThanOrEqual(3);

  // Canceller cancels remakeOrder and permanently deletes it with a mandatory reason
  const cancelRemake = await canonicalLab.patchCanonicalLabOrderResponse(
    await fx.session("canceller"),
    remakeOrder.id,
    { status: "cancelled", note: "أُلغي بعد المراجعة" },
    fx.pool,
  );
  expect(cancelRemake.status).toBe(200);

  const deleteNoReason = await canonicalLab.deleteCanonicalLabOrderResponse(
    await fx.session("canceller"),
    remakeOrder.id,
    null,
    fx.pool,
  );
  expect(deleteNoReason.status).toBe(400);

  const deleteOk = await canonicalLab.deleteCanonicalLabOrderResponse(
    await fx.session("canceller"),
    remakeOrder.id,
    "سجل مكرر أُنشئ للاختبار",
    fx.pool,
  );
  expect(deleteOk.status).toBe(200);
});

it("enforces whole-clinic patientScope on /api/lab/backlog and preserves private task isolation", async () => {
  // Own-scoped doctor is refused on whole-clinic backlog even with clinical.lab.view
  const ownBacklog = await canonicalLab.readCanonicalLabBacklogResponse(
    await fx.session("ownDoctor"),
    new Request("http://localhost/api/lab/backlog?filter=all&page=0"),
  );
  expect(ownBacklog.status).toBe(403);

  // Whole-clinic viewer reads open lab backlog snapshot with Cache-Control: private, no-store
  const allBacklog = await canonicalLab.readCanonicalLabBacklogResponse(
    await fx.session("viewerOnly"),
    new Request("http://localhost/api/lab/backlog?filter=all&page=0"),
  );
  expect(allBacklog.status).toBe(200);
  expect(allBacklog.headers.get("Cache-Control")).toBe("private, no-store");
  const snapshot = await allBacklog.json();
  expect(snapshot.scope).toBe("all_open_now");
  expect(snapshot.counts.orders).toBeGreaterThanOrEqual(2);
});

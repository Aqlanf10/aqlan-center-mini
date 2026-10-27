import { expect, it, vi } from "vitest";
import { readReturnBookingContext } from "../lib/return-booking-context";
function db(change: Record<string, unknown> = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("FROM audit_log")) return { rows: [{ revision: "0" }] };
    if (sql.includes("FOR SHARE")) return { rows: [{ id: 10 }] };
    if (sql.includes("FROM clinical_cases")) return { rows: [{ id: 10, patient_id: 19, specialty: "endodontics", title: "Exact case", ortho_case_id: null, responsible_party_id: 8, status: "active", ...change }] };
    if (sql.includes("FROM parties")) return { rows: [{ id: 8, name: "Current clinician", kind: "doctor", is_active: true }] };
    if (sql.includes("FROM plan_items")) return { rows: [{ id: 31, plan_id: 20, case_id: 10, status: "active", doctor_id: 7 }] };
    if (sql.includes("FROM treatment_plans")) return { rows: [{ id: 20, patient_id: 19, status: "active" }] };
    throw new Error(sql);
  }); return { query } as unknown as Parameters<typeof readReturnBookingContext>[0];
}
it("uses the current exact case clinician, never the historical item clinician", async () => {
  expect(await readReturnBookingContext(db(), 19, { kind: "plan_item", id: 31 })).toMatchObject({ ok: true, doctorId: 8, doctorName: "Current clinician", clinicalCaseId: 10 });
});
it("fails closed for missing current owner rather than using item attribution", async () => {
  expect(await readReturnBookingContext(db({ responsible_party_id: null }), 19, { kind: "plan_item", id: 31 })).toMatchObject({ ok: false, code: "responsibility_missing" });
});
it("rejects a foreign patient's case", async () => {
  expect(await readReturnBookingContext(db({ patient_id: 20 }), 19, { kind: "clinical_case", id: 10 })).toMatchObject({ ok: false });
});
it("locks and re-reads current ownership before returning booking authority", async () => {
  const client = db();
  expect(await readReturnBookingContext(client, 19, { kind: "clinical_case", id: 10 }, { lock: true })).toMatchObject({ ok: true });
  expect(vi.mocked(client.query).mock.calls.some(call => String(call[0]).includes("FOR SHARE NOWAIT"))).toBe(true);
});

function graph(overrides: Record<string, any[]> = {}) {
  const tables: Record<string, any[]> = {
    clinical_cases: [{ id: 10, patient_id: 19, specialty: "endodontics", title: "Endo", ortho_case_id: null, responsible_party_id: 8, status: "active" },
      { id: 11, patient_id: 19, specialty: "surgery", title: "Surgery", ortho_case_id: null, responsible_party_id: 9, status: "active" }],
    parties: [{ id: 8, name: "Current", kind: "doctor", is_active: true }, { id: 9, name: "Other current", kind: "doctor", is_active: true }],
    visits: [{ id: 40, patient_id: 19, case_id: 10 }], treatment_sessions: [{ id: 1, visit_id: 40, planned_visit_id: 60, plan_item_id: 31 }, { id: 2, visit_id: 40, planned_visit_id: 60, plan_item_id: 32 }],
    visit_procedures: [], plan_items: [{ id: 31, plan_id: 20, case_id: 10, status: "active", doctor_id: 7 }, { id: 32, plan_id: 20, case_id: 11, status: "active", doctor_id: 7 }],
    treatment_plans: [{ id: 20, patient_id: 19, status: "active" }], planned_visits: [{ id: 60, patient_id: 19, visit_id: null, status: "planned" }],
    ortho_cases: [], ortho_adjustments: [], endo_visits: [], endo_treatments: [], lab_orders: [], lab_work_intents: [], lab_work_members: [], ...overrides,
  };
  const query = vi.fn(async (sql: string, args: any[]) => {
    if (sql.includes("FROM audit_log")) return { rows: [{ revision: "0" }] };
    const table = sql.match(/FROM (\w+)/)?.[1];
    if (!table || !tables[table]) throw new Error(sql);
    let rows = tables[table];
    if (sql.includes("FOR SHARE")) return { rows: rows.map(row => ({ id: row.id })) };
    if (sql.includes("WHERE ortho_case_id")) rows = rows.filter(row => row.ortho_case_id === args[0]);
    else if (sql.includes("WHERE visit_id")) rows = rows.filter(row => row.visit_id === args[0]);
    else if (sql.includes("WHERE planned_visit_id")) rows = rows.filter(row => row.planned_visit_id === args[0]);
    else if (sql.includes("WHERE intent_id")) rows = rows.filter(row => row.intent_id === args[0]);
    else if (sql.includes("ANY(")) rows = rows.filter(row => args[0].includes(row.id));
    else rows = rows.filter(row => row.id === args[0]);
    return { rows };
  });
  return { query } as unknown as Parameters<typeof readReturnBookingContext>[0];
}
it("requires exact source selection for a multi-case visit even if a direct case exists", async () => {
  expect(await readReturnBookingContext(graph(), 19, { kind: "visit", id: 40 })).toMatchObject({ ok: false, code: "return_source_ambiguous", contexts: [{ doctorId: 8 }, { doctorId: 9 }] });
  expect(await readReturnBookingContext(graph(), 19, { kind: "clinical_case", id: 11 }, { origin: { kind: "visit", id: 40 } })).toMatchObject({ ok: true, doctorId: 9 });
});
it("does not allow an unrelated selected case to replace a verified origin", async () => {
  expect(await readReturnBookingContext(graph({ treatment_sessions: [{ id: 1, visit_id: 40, plan_item_id: 31 }] }), 19,
    { kind: "clinical_case", id: 11 }, { origin: { kind: "visit", id: 40 } })).toMatchObject({ ok: false });
});
it("planned sessions resolve their cases, not the old planned clinician", async () => {
  expect(await readReturnBookingContext(graph(), 19, { kind: "planned_visit", id: 60 })).toMatchObject({ ok: false, code: "return_source_ambiguous" });
});
it("canonical current ortho ownership wins over original bridge and item attribution", async () => {
  const client = graph({ clinical_cases: [{ id: 10, patient_id: 19, specialty: "orthodontics", title: "Ortho", ortho_case_id: 3, responsible_party_id: 7, status: "active" }],
    ortho_cases: [{ id: 3, patient_id: 19, responsible_doctor_id: 8, status: "active" }], ortho_adjustments: [{ id: 50, case_id: 3 }] });
  expect(await readReturnBookingContext(client, 19, { kind: "ortho_adjustment", id: 50 })).toMatchObject({ ok: true, doctorId: 8, orthoCaseId: 3, clinicalCaseId: 10 });
});
it.each([
  { parties: [{ id: 8, name: "Inactive", kind: "doctor", is_active: false }] },
  { parties: [{ id: 8, name: "Supplier", kind: "supplier", is_active: true }] },
])("never substitutes another roster clinician for an inactive/invalid owner %#", async overrides => {
  expect(await readReturnBookingContext(graph(overrides), 19, { kind: "clinical_case", id: 10 })).toMatchObject({ ok: false, code: "responsibility_inactive" });
});
it("does not use the old visit doctor when no exact current-care context exists", async () => {
  expect(await readReturnBookingContext(graph({ visits: [{ id: 40, patient_id: 19, case_id: null, doctor_id: 8 }], treatment_sessions: [], visit_procedures: [] }), 19, { kind: "visit", id: 40 })).toMatchObject({ ok: false, code: "return_source_missing" });
});
it("missing item case cannot be hidden by another case on the same visit", async () => {
  expect(await readReturnBookingContext(graph({ plan_items: [{ id: 31, plan_id: 20, case_id: null, status: "active" }, { id: 32, plan_id: 20, case_id: 11, status: "active" }] }), 19, { kind: "visit", id: 40 })).toMatchObject({ ok: false });
});
it("rejects changed ownership between observation and locked reread", async () => {
  const client = graph(); const original = client.query; let locked = false;
  client.query = vi.fn(async (sql: any, args: any) => {
    if (String(sql).includes("FOR SHARE")) locked = true;
    const result = await original(sql, args);
    if (locked && String(sql).includes("SELECT id, patient_id, specialty")) result.rows = result.rows.map((row: any) => ({ ...row, responsible_party_id: 9 }));
    return result;
  }) as typeof client.query;
  expect(await readReturnBookingContext(client, 19, { kind: "clinical_case", id: 10 }, { lock: true })).toMatchObject({ ok: false, code: "return_source_changed" });
});
it("resolves a materialized lab work's exact item case, never its frozen member clinician", async () => {
  expect(await readReturnBookingContext(graph({ lab_orders: [{ id: 70, patient_id: 19, status: "received", visit_id: null, lab_work_intent_id: "intent" }],
    lab_work_intents: [{ id: "intent", patient_id: 19, state: "materialized" }], lab_work_members: [{ id: "member", intent_id: "intent", patient_id: 19, plan_item_id: 31, doctor_id: 7 }] }), 19, { kind: "lab_work", id: 70 })).toMatchObject({ ok: true, doctorId: 8, clinicalCaseId: 10 });
});
it("does not fall back to a lab order's recorded clinician when no source is verified", async () => {
  expect(await readReturnBookingContext(graph({ lab_orders: [{ id: 70, patient_id: 19, status: "received", visit_id: null, lab_work_intent_id: null, doctor_id: 8 }] }), 19, { kind: "lab_work", id: 70 })).toMatchObject({ ok: false, code: "return_source_missing" });
});
it("rejects a planned session linked to another plan even within the same patient", async () => {
  expect(await readReturnBookingContext(graph({ planned_visits: [{ id: 60, patient_id: 19, plan_id: 21, visit_id: null, status: "planned" }] }), 19, { kind: "planned_visit", id: 60 })).toMatchObject({ ok: false });
});

it("uses exact endodontic work case when a legacy visit has no generic case link", async () => {
  expect(await readReturnBookingContext(graph({ visits: [{ id: 40, patient_id: 19, case_id: null }], treatment_sessions: [],
    endo_visits: [{ id: 45, visit_id: 40, treatment_id: 46, doctor_id: 7 }], endo_treatments: [{ id: 46, patient_id: 19, case_id: 10, status: "in_progress" }] }), 19, {kind:"visit",id:40})).toMatchObject({ok:true,doctorId:8});
});

it("uses only the unique same-patient explicit bridge owner when canonical ortho owner is unset", async () => {
  const tables = { clinical_cases: [{id:10,patient_id:19,specialty:"orthodontics",title:"Ortho",ortho_case_id:3,responsible_party_id:8,status:"active"}],
    ortho_cases: [{id:3,patient_id:19,responsible_doctor_id:null,status:"active"}] };
  expect(await readReturnBookingContext(graph(tables),19,{kind:"ortho_case",id:3})).toMatchObject({ok:true,doctorId:8});
  expect(await readReturnBookingContext(graph({...tables,clinical_cases:[{...tables.clinical_cases[0],patient_id:20}]}),19,{kind:"ortho_case",id:3})).toMatchObject({ok:false});
  expect(await readReturnBookingContext(graph({...tables,clinical_cases:[{...tables.clinical_cases[0],responsible_party_id:null}]}),19,{kind:"ortho_case",id:3})).toMatchObject({ok:false,code:"responsibility_missing"});
});
it("uses the same fingerprint for the default preview and identical inferred origin", async () => {
 const source = { kind: "clinical_case" as const, id: 10 };
 const preview = await readReturnBookingContext(db(), 19, source);
 const inferred = await readReturnBookingContext(db(), 19, source, { origin: source, lock: true });
 expect(preview.ok).toBe(true); expect(inferred.ok).toBe(true);
 if (preview.ok && inferred.ok) expect(inferred.fingerprint).toBe(preview.fingerprint);
});

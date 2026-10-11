import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, rawPool, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { invoiceCommandFingerprint, invoiceTemplateRequestFingerprint, parseInvoiceCommand, type InvoiceTemplateSelection } from "../../lib/invoice-template";
import type { SessionPayload } from "../../lib/auth";

/** Real PostgreSQL regressions for server-expanded templates inside the canonical invoice transaction. */
assertRealPostgresUrl();
stubPostgresEnv();
process.env.SESSION_SECRET ??= "synthetic-invoice-template-pg-session-secret-only";

const db = await import("../../lib/db");
const { createLinkedInvoice, previewInvoiceLinkage, recoverLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { InvoiceTemplateAuthorityError, InvoiceTemplateBusyError, InvoiceTemplateAuthorizationError } = await import("../../lib/invoice-template-db");
const { hashPassword, sessionCredentialVersion } = await import("../../lib/auth");
const { ensureSchema, getPool, resetPoolForTesting } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctor = 0;
let recoverySession: SessionPayload;
let recoveryPasswordHash = "";
let replacementPasswordHash = "";
let commandSerial = 0;
const serviceIds = { ortho: 0, records: 0, rct: 0 };

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  recoveryPasswordHash = await hashPassword("synthetic-template-test-password-not-a-real-account");
  replacementPasswordHash = await hashPassword("synthetic-template-replacement-password-not-a-real-account");
  const [user] = await q<{ id: number }>(`INSERT INTO users (username, display_name, password_hash, role, is_active)
    VALUES ('reception', 'Template recovery test receptionist', $1, 'reception', TRUE)
    ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role, is_active = TRUE
    RETURNING id`, [recoveryPasswordHash]);
  recoverySession = { userId: user.id, username: "reception", role: "reception", expiresAt: Date.now() + 3_600_000,
    credentialVersion: sessionCredentialVersion(recoveryPasswordHash) };
  doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Template test doctor') RETURNING id`))[0].id;
  for (const [key, name, category] of [
    ["ortho", "Template orthodontics", "ortho"],
    ["records", "Template records", "consultation"],
    ["rct", "Template endodontics", "rct"],
  ] as const) {
    serviceIds[key] = (await q<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category)
       VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`, [name, category]))[0].id;
  }
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const newPatient = async (number: string) => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [number]))[0].id;

function selection(templateId: "ortho" | "endo", teeth: number[] = [], records = false): InvoiceTemplateSelection {
  return templateId === "ortho" ? {
    templateId, teeth: [], doctorId: doctor,
    steps: [
      { key: "records", include: records, serviceId: serviceIds.records },
      { key: "ortho", include: true, serviceId: serviceIds.ortho },
    ],
    sites: [{ stepKey: "ortho", toothCode: null, scope: "both" }],
  } : {
    templateId, teeth, doctorId: doctor,
    steps: [{ key: "rct", include: true, serviceId: serviceIds.rct }],
  };
}

type Command = Extract<ReturnType<typeof parseInvoiceCommand>, { ok: true }> & { source: Record<string, unknown> };

/** Exercise the real preview/version/save expansion; no test fabricates a templatePlan object. */
async function command(patientId: number, templateSelection: InvoiceTemplateSelection, key: string | null = null,
  manual: Record<string, unknown>[] = []): Promise<Command> {
  const services = new Map((await db.listServices()).map((service) => [service.id, service]));
  const doctors = new Set([doctor]);
  db.invalidateSettingsCache();
  const settings = await db.getSettings();
  const source = { patientId, currency: "YER", items: manual, idempotencyKey: key ?? `tpl:patient-${patientId}-command-${++commandSerial}`, templateSelection };
  const reviewed = parseInvoiceCommand(source, services, doctors, settings, false);
  if (!reviewed.ok) throw new Error(reviewed.message);
  if (!reviewed.template) throw new Error("Expected a server-expanded template preview");
  const reviewedSource = { ...source, templateSelection: { ...templateSelection, version: reviewed.template.version } };
  const saved = parseInvoiceCommand(reviewedSource,
    services, doctors, settings, true);
  if (!saved.ok) throw new Error(saved.message);
  expect(saved.items.filter((item) => item.templatePlan)).toHaveLength(saved.template!.lines.length);
  return { ...saved, source: reviewedSource };
}

const save = (input: Command, session: SessionPayload = recoverySession) => createLinkedInvoice({
  patientId: input.patientId, existingPlanId: input.existingPlanId, baseCurrency: input.baseCurrency,
  discountMinor: input.discountMinor, note: input.note, items: input.items,
  createdBy: session.username, actorRole: session.role, templates: DEFAULT_SPECIALTY_TEMPLATES,
  idempotencyKey: input.idempotencyKey,
  requestHash: input.idempotencyKey ? invoiceTemplateRequestFingerprint(input.source, session) : null,
  templateAuthority: { source: input.source, fingerprint: invoiceCommandFingerprint(input), session },
  auditDetails: { template: input.template?.templateId, templateVersion: input.template?.version },
});
const preview = (input: Command) => previewInvoiceLinkage({
  patientId: input.patientId, existingPlanId: input.existingPlanId, baseCurrency: input.baseCurrency, items: input.items,
});

type Counts = { invoices: number; invoiceLines: number; plans: number; items: number; cases: number;
  visits: number; sessions: number; installments: number; orthoCases: number };
const counts = async (patientId: number): Promise<Counts> => (await q<Counts>(
  `SELECT (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
    (SELECT COUNT(*)::int FROM invoice_items ii JOIN invoices v ON v.id = ii.invoice_id WHERE v.patient_id = $1) AS "invoiceLines",
    (SELECT COUNT(*)::int FROM treatment_plans WHERE patient_id = $1) AS plans,
    (SELECT COUNT(*)::int FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1) AS items,
    (SELECT COUNT(*)::int FROM clinical_cases WHERE patient_id = $1) AS cases,
    (SELECT COUNT(*)::int FROM planned_visits WHERE patient_id = $1) AS visits,
    (SELECT COUNT(*)::int FROM treatment_sessions s JOIN plan_items i ON i.id = s.plan_item_id
      JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1) AS sessions,
    (SELECT COUNT(*)::int FROM plan_installments p JOIN treatment_plans t ON t.id = p.plan_id WHERE t.patient_id = $1) AS installments,
    (SELECT COUNT(*)::int FROM ortho_cases WHERE patient_id = $1) AS "orthoCases"`, [patientId]))[0];

const scheduleSnapshot = (patientId: number) => q(
  `SELECT i.id AS item_id, i.billing_rule, i.session_count, i.billing_status, i.billed_invoice_id,
    s.id AS session_id, s.sequence, s.title, s.status, s.planned_duration, s.planned_visit_id,
    v.sequence AS visit_sequence, v.title AS visit_title, v.duration_minutes, v.after_days, v.doctor_id
   FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id
   JOIN treatment_sessions s ON s.plan_item_id = i.id JOIN planned_visits v ON v.id = s.planned_visit_id
   WHERE t.patient_id = $1 ORDER BY i.id, s.sequence`, [patientId]);

describe("canonical invoice template linkage", () => {
  it("keeps optional records scheduled and financial-only, while the ortho item gets one intake case", async () => {
    const patient = await newPatient("TPL-RECORDS");
    const input = await command(patient, selection("ortho", [], true));
    const proposed = await preview(input);
    expect(proposed[0]).toMatchObject({ kind: "financial", scheduled: true, specialty: null,
      item: { mode: "new", id: null }, case: { mode: "none" }, refusal: null });
    expect(proposed[1]).toMatchObject({ kind: "clinical", scheduled: true, specialty: "orthodontics", refusal: null });
    const result = await save(input);
    if (!result.ok) throw new Error(result.reason);
    expect(result.links[0]).toMatchObject({ kind: "financial", scheduled: true, specialty: null,
      planItemCreated: true, caseId: null, caseCreated: false });
    expect(result.links[0].planItemId).not.toBeNull();
    expect(result.links[1]).toMatchObject({ kind: "clinical", specialty: "orthodontics", caseCreated: true });
    expect(await counts(patient)).toEqual({ invoices: 1, invoiceLines: 2, plans: 1, items: 2, cases: 1,
      visits: 13, sessions: 13, installments: 0, orthoCases: 0 });
    expect(await q(`SELECT category, case_id, billing_rule, session_count FROM plan_items WHERE plan_id = $1 ORDER BY id`, [result.planId]))
      .toEqual([
        { category: "consultation", case_id: null, billing_rule: "on_completion", session_count: 1 },
        { category: "ortho", case_id: result.links[1].caseId, billing_rule: "per_session", session_count: 12 },
      ]);
    expect(await q(`SELECT consent_at, primary_doctor_id FROM treatment_plans WHERE id = $1`, [result.planId]))
      .toEqual([{ consent_at: null, primary_doctor_id: doctor }]);
    const visits = await q<{ title: string; duration_minutes: number; after_days: number; doctor_id: number }>(
      `SELECT title, duration_minutes, after_days, doctor_id FROM planned_visits WHERE plan_id = $1 ORDER BY sequence`, [result.planId]);
    expect(visits).toEqual(input.items.flatMap((item) => item.templatePlan!.sessionPlan.map((session) => ({
      title: session.visitTitle, duration_minutes: session.minutes, after_days: session.afterDays, doctor_id: doctor,
    }))));
    expect(await q(`SELECT source_type, source_id::int AS source_id, plan_item_id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [result.invoice.id]))
      .toEqual(result.links.map((link) => ({ source_type: "plan_item", source_id: link.planItemId, plan_item_id: link.planItemId })));
  });

  it("groups two teeth into three shared template visits and preserves exact session titles, durations and gaps", async () => {
    const patient = await newPatient("TPL-TWO-TEETH");
    const input = await command(patient, selection("endo", [36, 46]));
    const result = await save(input);
    if (!result.ok) throw new Error(result.reason);
    expect(await counts(patient)).toMatchObject({ invoices: 1, plans: 1, items: 2, cases: 2, visits: 3, sessions: 6 });
    const visits = await q<{ id: number; title: string; duration_minutes: number; after_days: number }>(
      `SELECT id, title, duration_minutes, after_days FROM planned_visits WHERE plan_id = $1 ORDER BY sequence`, [result.planId]);
    expect(visits.map(({ id: _id, ...visit }) => { void _id; return visit; }))
      .toEqual(input.items[0].templatePlan!.sessionPlan.map((session) => ({
        title: session.visitTitle, duration_minutes: session.minutes * 2, after_days: session.afterDays,
      })));
    expect(visits.map((visit) => visit.after_days)).toEqual([0, 7, 7]);
    for (const [index, link] of result.links.entries()) {
      const sessions = await q(`SELECT sequence, title, planned_duration, planned_visit_id FROM treatment_sessions WHERE plan_item_id = $1 ORDER BY sequence`, [link.planItemId]);
      expect(sessions).toEqual(input.items[index].templatePlan!.sessionPlan.map((session, sessionIndex) => ({
        sequence: sessionIndex + 1, title: session.title, planned_duration: session.minutes, planned_visit_id: visits[sessionIndex].id,
      })));
    }
  });

  it("replays exact invoice, item, case and visit identities without calling scheduled records clinical", async () => {
    const patient = await newPatient("TPL-REPLAY");
    const input = await command(patient, selection("ortho", [], true), "tpl:replay-00001");
    const first = await save(input);
    if (!first.ok) throw new Error(first.reason);
    const before = await counts(patient);
    const schedule = await scheduleSnapshot(patient);
    const again = await save(input);
    if (!again.ok) throw new Error(again.reason);
    expect(again.replayed).toBe(true);
    expect(again.invoice.id).toBe(first.invoice.id);
    expect(again.planId).toBe(first.planId);
    const identity = (links: typeof first.links) => links.map(({ kind, specialty, planItemId, caseId, scheduled }) => ({ kind, specialty, planItemId, caseId, scheduled }));
    expect(identity(again.links)).toEqual(identity(first.links));
    expect(again.links.every((link) => !link.planItemCreated && !link.caseCreated)).toBe(true);
    expect(await counts(patient)).toEqual(before);
    expect(await scheduleSnapshot(patient)).toEqual(schedule);
    const changed = await command(patient, selection("ortho", [], false), input.idempotencyKey);
    expect(await save(changed)).toEqual({ ok: false, reason: "idempotency_conflict", line: null });
    expect(await counts(patient)).toEqual(before);
  });

  it("serializes same-key double submits and rejects a second-key obligation for the same treatment", async () => {
    const patient = await newPatient("TPL-CONCURRENT");
    const input = await command(patient, selection("ortho", [], true), "tpl:concurrent-same-01");
    const results = await Promise.all(Array.from({ length: 4 }, () => save(input)));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(new Set(results.map((result) => result.ok ? result.invoice.id : null)).size).toBe(1);
    expect(results.filter((result) => result.ok && !result.replayed)).toHaveLength(1);
    expect(await counts(patient)).toMatchObject({ invoices: 1, invoiceLines: 2, plans: 1, items: 2, cases: 1, visits: 13, sessions: 13 });
    const other = await newPatient("TPL-CONCURRENT-KEYS");
    const a = await command(other, selection("endo", [36]), "tpl:concurrent-a-01");
    const b = await command(other, selection("endo", [36]), "tpl:concurrent-b-01");
    const tabs = await Promise.all([save(a), save(b)]);
    expect(tabs.filter((result) => result.ok)).toHaveLength(1);
    expect(tabs.find((result) => !result.ok)).toEqual({ ok: false, reason: "already_billed", line: 0 });
    expect(await counts(other)).toMatchObject({ invoices: 1, plans: 1, items: 1, cases: 1, visits: 3, sessions: 3 });
  });

  it("recovers a lost acknowledgement after settings/catalogue edits only for the exact actor, patient and submitted intent", async () => {
    const patient = await newPatient("TPL-LOST-ACK");
    const otherPatient = await newPatient("TPL-LOST-ACK-OTHER");
    const input = await command(patient, selection("ortho", [], true), "tpl:lost-ack-0001");
    const original = await save(input); // The transaction committed, but its response is treated as lost.
    if (!original.ok) throw new Error(original.reason);
    const before = await counts(patient);
    const schedule = await scheduleSnapshot(patient);
    const originalLines = await q(`SELECT id, service_id, doctor_id, quantity, unit_price_minor, total_minor,
      source_type, source_id, plan_item_id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [original.invoice.id]);
    const oldSetting = await q<{ value: string }>(`SELECT value FROM settings WHERE key = 'plans.specialty_templates'`);
    const actor = { username: "reception", role: "reception", userId: recoverySession.userId };
    const recover = (source: Record<string, unknown> = input.source, auth = actor,
      patientId = patient, key = input.idempotencyKey!) => recoverLinkedInvoice({
      patientId, idempotencyKey: key, requestHash: invoiceTemplateRequestFingerprint(source, auth), createdBy: auth.username,
      session: recoverySession,
    });
    const observers = rawPool();
    const holder = await observers.connect();
    let pending: Promise<Awaited<ReturnType<typeof recoverLinkedInvoice>>[]> | null = null;
    try {
      const edited = DEFAULT_SPECIALTY_TEMPLATES.map((template) => template.id === "ortho"
        ? { ...template, name: `${template.name} changed after the committed invoice` } : template);
      await q(`INSERT INTO settings (key, value) VALUES ('plans.specialty_templates', $1)
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(edited)]);
      await q(`UPDATE services SET price_minor = 100100 WHERE id = ANY($1::int[])`, [[serviceIds.ortho, serviceIds.records]]);
      const recovered = await recover();
      if (!recovered?.ok) throw new Error("Exact immutable intent did not recover its committed invoice");
      expect(recovered).toMatchObject({ ok: true, replayed: true, planId: original.planId, invoice: { id: original.invoice.id } });
      expect(recovered.links.map(({ kind, specialty, planItemId, caseId, scheduled }) => ({ kind, specialty, planItemId, caseId, scheduled })))
        .toEqual(original.links.map(({ kind, specialty, planItemId, caseId, scheduled }) => ({ kind, specialty, planItemId, caseId, scheduled })));
      expect(recovered.links[0]).toMatchObject({ kind: "financial", scheduled: true, caseId: null });
      // The direct writer's existing-key fast path has the same immutable recovery contract.
      expect(await save(input)).toMatchObject({ ok: true, replayed: true, invoice: { id: original.invoice.id } });
      const conflict = { ok: false, reason: "idempotency_conflict", line: null };
      expect(await recover({ ...input.source, note: "Different submitted intention" })).toEqual(conflict);
      // Objects and entry arrays were once canonicalized identically; changing JSON type is changed intent.
      const rawSelection = input.source.templateSelection as Record<string, unknown>;
      const entryArray = Object.entries(rawSelection).sort(([a], [b]) => a.localeCompare(b));
      const changedType = { ...input.source, templateSelection: entryArray };
      expect(invoiceTemplateRequestFingerprint(changedType, actor)).not.toBe(invoiceTemplateRequestFingerprint(input.source, actor));
      expect(await recover(changedType)).toEqual(conflict);
      await expect(recover(input.source, { username: "another-receptionist", role: "reception", userId: recoverySession.userId }))
        .rejects.toBeInstanceOf(InvoiceTemplateAuthorizationError);
      expect(await recover(input.source, { username: "reception", role: "admin", userId: recoverySession.userId })).toEqual(conflict);
      expect(await recover(input.source, { ...actor, userId: recoverySession.userId + 1 })).toEqual(conflict);
      expect(await recover({ ...input.source, patientId: otherPatient }, actor, otherPatient)).toEqual(conflict);
      // The admitted session's creator fence is checked independently of the supplied fingerprint.
      await expect(recoverLinkedInvoice({ patientId: patient, idempotencyKey: input.idempotencyKey!,
        requestHash: invoiceTemplateRequestFingerprint(input.source, actor), createdBy: "another-receptionist", session: recoverySession }))
        .rejects.toBeInstanceOf(InvoiceTemplateAuthorizationError);

      const missingKey = "tpl:lost-ack-new-key";
      const changedSource = { ...input.source, idempotencyKey: missingKey };
      expect(await recover(changedSource, actor, patient, missingKey)).toBeNull();
      // A new key cannot use recovery to bypass the reviewed version/current catalogue authority.
      await expect(save({ ...input, source: changedSource, idempotencyKey: missingKey }))
        .rejects.toBeInstanceOf(InvoiceTemplateAuthorityError);

      await holder.query("BEGIN");
      const { rows: [{ pid }] } = await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      await holder.query(`SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`, [patient]);
      let settled = false;
      pending = Promise.all(Array.from({ length: 4 }, () => recover())).finally(() => { settled = true; });
      await expect.poll(async () => (await observers.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))) AS blocked`, [pid])).rows[0].blocked,
      { timeout: 5000, interval: 20 }).toBe(true);
      expect(settled).toBe(false);
      await holder.query("COMMIT");
      const recoveredTogether = await pending;
      expect(recoveredTogether.every((result) => result?.ok && result.replayed && result.invoice.id === original.invoice.id)).toBe(true);
      expect(await counts(patient)).toEqual(before);
      expect(await counts(otherPatient)).toMatchObject({ invoices: 0, plans: 0, items: 0, visits: 0, sessions: 0 });
      expect(await scheduleSnapshot(patient)).toEqual(schedule);
      expect(await q(`SELECT id, service_id, doctor_id, quantity, unit_price_minor, total_minor,
        source_type, source_id, plan_item_id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [original.invoice.id])).toEqual(originalLines);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await pending?.catch(() => undefined);
      holder.release();
      await observers.end();
      await q(`UPDATE services SET price_minor = 100000 WHERE id = ANY($1::int[])`, [[serviceIds.ortho, serviceIds.records]]);
      if (oldSetting.length) {
        await q(`INSERT INTO settings (key, value) VALUES ('plans.specialty_templates', $1)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [oldSetting[0].value]);
      } else {
        await q(`DELETE FROM settings WHERE key = 'plans.specialty_templates'`);
      }
      db.invalidateSettingsCache();
    }
  });

  it("builds the recovered canonical DTO without acquiring another application-pool connection", async () => {
    const patient = await newPatient("TPL-RECOVERY-SAME-CLIENT");
    const input = await command(patient, selection("ortho", [], true), "tpl:recovery-same-client");
    const original = await save(input);
    if (!original.ok) throw new Error(original.reason);
    const connect = vi.spyOn(getPool(), "connect");
    try {
      const recovered = await recoverLinkedInvoice({ patientId: patient, idempotencyKey: input.idempotencyKey!,
        requestHash: invoiceTemplateRequestFingerprint(input.source, recoverySession), createdBy: recoverySession.username,
        session: recoverySession });
      expect(recovered).toMatchObject({ ok: true, replayed: true, invoice: { id: original.invoice.id, patientId: patient } });
      // getInvoice(id, client) and itemsFor(..., client) must reuse the borrowed transaction client.
      expect(connect).toHaveBeenCalledTimes(1);
      if (!recovered?.ok) throw new Error("Missing recovered canonical DTO");
      expect(recovered.invoice.items.map((item) => [item.planItemId ?? null, item.caseId ?? null]))
        .toEqual(recovered.links.map((link) => [link.planItemId, link.caseId]));
    } finally { connect.mockRestore(); }
  });

  it.each([
    ["recover", "inactive"], ["recover", "credentials"], ["recover", "role"],
    ["write", "inactive"], ["write", "credentials"],
  ] as const)("revalidates admitted session after a held patient lock: %s with %s revoked", async (operation, revocation) => {
    const patient = await newPatient(`TPL-REVOKED-${operation}-${revocation}`);
    const input = await command(patient, selection("endo", [36]), `tpl:revoked-${operation}-${revocation}`);
    if (operation === "recover") expect(await save(input)).toMatchObject({ ok: true });
    const before = await counts(patient);
    const schedule = await scheduleSnapshot(patient);
    const audits = await q(`SELECT COUNT(*)::int AS count FROM audit_log`);
    const observers = rawPool();
    const holder = await observers.connect();
    let pending: Promise<{ result: Awaited<ReturnType<typeof recoverLinkedInvoice>>; error: unknown }> | null = null;
    try {
      await holder.query("BEGIN");
      const { rows: [{ pid }] } = await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      await holder.query(`SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE`, [patient]);
      const action = operation === "recover" ? recoverLinkedInvoice({ patientId: patient, idempotencyKey: input.idempotencyKey!,
        requestHash: invoiceTemplateRequestFingerprint(input.source, recoverySession), createdBy: recoverySession.username,
        session: recoverySession }) : save(input);
      pending = action.then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
      await expect.poll(async () => (await observers.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))) AS blocked`, [pid])).rows[0].blocked,
      { timeout: 5000, interval: 20 }).toBe(true);
      if (revocation === "inactive") await q(`UPDATE users SET is_active = FALSE WHERE id = $1`, [recoverySession.userId]);
      else if (revocation === "credentials") await q(`UPDATE users SET password_hash = $2 WHERE id = $1`, [recoverySession.userId, replacementPasswordHash]);
      else await q(`UPDATE users SET role = 'doctor' WHERE id = $1`, [recoverySession.userId]);
      await holder.query("COMMIT");
      const outcome = await pending;
      expect(outcome.result).toBeNull();
      expect(outcome.error).toBeInstanceOf(InvoiceTemplateAuthorizationError);
      expect(outcome.error).toMatchObject({ code: "INVOICE_SESSION_REVOKED" });
      expect(await counts(patient)).toEqual(before);
      expect(await scheduleSnapshot(patient)).toEqual(schedule);
      expect(await q(`SELECT COUNT(*)::int AS count FROM audit_log`)).toEqual(audits);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await pending;
      holder.release();
      await observers.end();
      await q(`UPDATE users SET is_active = TRUE, role = 'reception', password_hash = $2 WHERE id = $1`,
        [recoverySession.userId, recoveryPasswordHash]);
    }
    // Restored server-side identity is still the exact original creator; failures did not consume a new request.
    if (operation === "recover") {
      expect(await recoverLinkedInvoice({ patientId: patient, idempotencyKey: input.idempotencyKey!,
        requestHash: invoiceTemplateRequestFingerprint(input.source, recoverySession), createdBy: recoverySession.username,
        session: recoverySession })).toMatchObject({ ok: true, replayed: true });
    } else expect(await save(input)).toMatchObject({ ok: true, replayed: false });
  });

  it("rechecks session expiry after a later plan-lock wait before committing a template invoice", async () => {
    const patient = await newPatient("TPL-WRITE-EXPIRED-AFTER-WAIT");
    const existing = await db.createPlanV2({ patientId: patient, title: "Existing master for expiry wait", specialty: null,
      primaryDoctorId: doctor, billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-01",
      note: null, createdBy: "doctor", installments: [],
      items: [{ serviceId: serviceIds.rct, serviceName: "Other tooth", category: "rct", toothCode: 46,
        surfaces: null, quantity: 1, unitPriceMinor: 100_000, billingRule: "on_completion", sessionCount: 1, note: null }],
    });
    if (!existing.ok) throw new Error(existing.message);
    const input = await command(patient, selection("endo", [36]), "tpl:expiry-after-plan-wait");
    const before = await counts(patient);
    const schedule = await scheduleSnapshot(patient);
    const expiring = { ...recoverySession, expiresAt: Date.now() + 60_000 };
    const observers = rawPool();
    const holder = await observers.connect();
    let pending: Promise<{ result: Awaited<ReturnType<typeof save>> | null; error: unknown }> | null = null;
    let restoreClock: (() => void) | null = null;
    try {
      await holder.query("BEGIN");
      const { rows: [{ pid }] } = await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      await holder.query(`SELECT id FROM treatment_plans WHERE id = $1 FOR UPDATE`, [existing.planId]);
      pending = save(input, expiring).then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
      await expect.poll(async () => (await observers.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))) AS blocked`, [pid])).rows[0].blocked,
      { timeout: 5000, interval: 20 }).toBe(true);
      // The authenticated payload is unchanged; only server time advances beyond its fixed expiration.
      const clock = vi.spyOn(Date, "now").mockReturnValue(expiring.expiresAt + 1);
      restoreClock = () => { clock.mockRestore(); };
      await holder.query("COMMIT");
      const outcome = await pending;
      restoreClock();
      restoreClock = null;
      expect(outcome.result).toBeNull();
      expect(outcome.error).toBeInstanceOf(InvoiceTemplateAuthorizationError);
      expect(await counts(patient)).toEqual(before);
      expect(await scheduleSnapshot(patient)).toEqual(schedule);
    } finally {
      restoreClock?.();
      await holder.query("ROLLBACK").catch(() => undefined);
      await pending;
      holder.release();
      await observers.end();
    }
  });

  it("refuses recovery if the locked invoice moves to another patient instead of returning a cross-patient DTO", async () => {
    const patient = await newPatient("TPL-RECOVERY-PATIENT-OLD");
    const otherPatient = await newPatient("TPL-RECOVERY-PATIENT-NEW");
    const input = await command(patient, selection("ortho", [], true), "tpl:recovery-patient-drift");
    const original = await save(input);
    if (!original.ok) throw new Error(original.reason);
    const before = await counts(patient);
    const schedule = await scheduleSnapshot(patient);
    const audits = await q(`SELECT COUNT(*)::int AS count FROM audit_log`);
    const observers = rawPool();
    const editor = await observers.connect();
    let pending: Promise<{ result: Awaited<ReturnType<typeof recoverLinkedInvoice>>; error: unknown }> | null = null;
    try {
      await editor.query("BEGIN");
      const { rows: [{ pid }] } = await editor.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      await editor.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [original.invoice.id]);
      pending = recoverLinkedInvoice({ patientId: patient, idempotencyKey: input.idempotencyKey!,
        requestHash: invoiceTemplateRequestFingerprint(input.source, recoverySession), createdBy: recoverySession.username,
        session: recoverySession }).then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
      await expect.poll(async () => (await observers.query<{ blocked: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))) AS blocked`, [pid])).rows[0].blocked,
      { timeout: 5000, interval: 20 }).toBe(true);
      // Deliberate isolated inconsistency simulates a concurrent reassignment boundary, not a production merge operation.
      await editor.query(`UPDATE invoices SET patient_id = $2 WHERE id = $1`, [original.invoice.id, otherPatient]);
      await editor.query("COMMIT");
      const outcome = await pending;
      expect(outcome.error).toBeNull();
      expect(outcome.result).toEqual({ ok: false, reason: "idempotency_conflict", line: null });
      expect(outcome.result).not.toHaveProperty("invoice");
      expect(await counts(patient)).toEqual({ ...before, invoices: 0, invoiceLines: 0 });
      expect(await counts(otherPatient)).toMatchObject({ invoices: 1, invoiceLines: 2, plans: 0, items: 0, cases: 0 });
      expect(await scheduleSnapshot(patient)).toEqual(schedule);
      expect(await q(`SELECT COUNT(*)::int AS count FROM audit_log`)).toEqual(audits);
    } finally {
      await editor.query("ROLLBACK").catch(() => undefined);
      await pending;
      editor.release();
      await observers.end();
      await q(`UPDATE invoices SET patient_id = $2 WHERE id = $1`, [original.invoice.id, patient]);
    }
    expect(await counts(patient)).toEqual(before);
  });

  it("refuses template adoption of a matching old item instead of replacing its preexisting schedule", async () => {
    const patient = await newPatient("TPL-STALE-ITEM");
    const old = await db.createPlanV2({ patientId: patient, title: "Existing clinical work", specialty: null,
      primaryDoctorId: doctor, billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-01",
      note: null, createdBy: "doctor", installments: [],
      items: [{ serviceId: serviceIds.rct, serviceName: "Template endodontics", category: "rct", toothCode: 36,
        surfaces: null, quantity: 1, unitPriceMinor: 100_000, billingRule: "on_completion", sessionCount: 3, note: null }],
    });
    if (!old.ok) throw new Error(old.message);
    const input = await command(patient, selection("endo", [36]));
    const before = await counts(patient);
    const schedule = await scheduleSnapshot(patient);
    expect((await preview(input))[0].refusal).toBe("shape_mismatch");
    expect(await save(input)).toEqual({ ok: false, reason: "shape_mismatch", line: 0 });
    expect(await counts(patient)).toEqual(before);
    expect(await scheduleSnapshot(patient)).toEqual(schedule);
  });

  it("rejects a consultation billed manually alongside its template schedule, in preview and save", async () => {
    const patient = await newPatient("TPL-DUPLICATE-RECORDS");
    const input = await command(patient, selection("ortho", [], true), null,
      [{ serviceId: serviceIds.records, quantity: 1, doctorId: doctor }]);
    const before = await counts(patient);
    expect((await preview(input)).slice(0, 2).map((line) => line.refusal)).toEqual(["existing_work", "existing_work"]);
    expect(await save(input)).toEqual({ ok: false, reason: "existing_work", line: 0 });
    expect(await counts(patient)).toEqual(before);
  });

  it.each(["settings", "price"] as const)("handles a held %s edit safely and refuses its committed stale preview without writes", async (target) => {
    const patient = await newPatient(`TPL-STALE-${target}`);
    const input = await command(patient, selection("endo", [36]), `tpl:stale-${target}-0001`);
    const before = await counts(patient);
    const oldSetting = await q<{ value: string }>(`SELECT value FROM settings WHERE key = 'plans.specialty_templates'`);
    const observers = rawPool();
    const editor = await observers.connect();
    let pending: Promise<{ result: Awaited<ReturnType<typeof save>> | null; error: unknown }> | null = null;
    try {
      await editor.query("BEGIN");
      const { rows: [{ pid }] } = await editor.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      if (target === "price") {
        await editor.query(`UPDATE services SET price_minor = 100100 WHERE id = $1`, [serviceIds.rct]);
      } else {
        const edited = DEFAULT_SPECIALTY_TEMPLATES.map((template) => template.id === "endo"
          ? { ...template, name: `${template.name} edited after preview` } : template);
        await editor.query(`INSERT INTO settings (key, value) VALUES ('plans.specialty_templates', $1)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(edited)]);
      }
      let settled = false;
      pending = save(input).then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }))
        .finally(() => { settled = true; });
      if (target === "price") {
        // Row-level NOWAIT must finish while the editor still owns its lock, never wait for commit.
        await expect.poll(() => settled, { timeout: 5000, interval: 20 }).toBe(true);
        const busy = await pending;
        expect(busy.result).toBeNull();
        expect(busy.error).toBeInstanceOf(InvoiceTemplateBusyError);
        expect(await counts(patient)).toEqual(before);
        await editor.query("COMMIT");
        await expect(save(input)).rejects.toBeInstanceOf(InvoiceTemplateAuthorityError);
      } else {
        await expect.poll(async () => (await observers.query<{ blocked: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))) AS blocked`, [pid])).rows[0].blocked,
        { timeout: 5000, interval: 20 }).toBe(true);
        expect(settled).toBe(false);
        await editor.query("COMMIT");
        const outcome = await pending;
        expect(outcome.result).toBeNull();
        expect(outcome.error).toBeInstanceOf(InvoiceTemplateAuthorityError);
      }
      expect(await counts(patient)).toEqual(before);
    } finally {
      await editor.query("ROLLBACK").catch(() => undefined);
      await pending;
      editor.release();
      await observers.end();
      if (target === "price") {
        await q(`UPDATE services SET price_minor = 100000 WHERE id = $1`, [serviceIds.rct]);
      } else if (oldSetting.length) {
        await q(`INSERT INTO settings (key, value) VALUES ('plans.specialty_templates', $1)
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [oldSetting[0].value]);
      } else {
        await q(`DELETE FROM settings WHERE key = 'plans.specialty_templates'`);
      }
      db.invalidateSettingsCache();
    }
  });

  it("holds catalogue authority through commit so a later price edit cannot interleave with the invoice write", async () => {
    const patient = await newPatient("TPL-HELD-AUTHORITY");
    const existing = await db.createPlanV2({ patientId: patient, title: "Compatible master", specialty: null,
      primaryDoctorId: doctor, billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-01",
      note: null, createdBy: "doctor", installments: [],
      items: [{ serviceId: serviceIds.rct, serviceName: "Other tooth", category: "rct", toothCode: 46,
        surfaces: null, quantity: 1, unitPriceMinor: 100_000, billingRule: "on_completion", sessionCount: 1, note: null }],
    });
    if (!existing.ok) throw new Error(existing.message);
    const input = await command(patient, selection("endo", [36]), "tpl:held-authority-01");
    const observers = rawPool();
    const holder = await observers.connect();
    const editor = await observers.connect();
    let writing: Promise<{ result: Awaited<ReturnType<typeof save>> | null; error: unknown }> | null = null;
    let editing: Promise<{ error: unknown }> | null = null;
    try {
      await holder.query("BEGIN");
      const { rows: [{ pid: holderPid }] } = await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      await holder.query(`SELECT id FROM treatment_plans WHERE id = $1 FOR UPDATE`, [existing.planId]);
      writing = save(input).then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
      let writerPid = 0;
      await expect.poll(async () => {
        const { rows } = await observers.query<{ pid: number }>(
          `SELECT a.pid FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))`, [holderPid]);
        writerPid = rows[0]?.pid ?? 0;
        return writerPid > 0;
      }, { timeout: 5000, interval: 20 }).toBe(true);
      // The writer is past authority checks and blocked on the master plan, retaining selected-service SHARE row locks.
      await editor.query("BEGIN");
      const { rows: [{ pid: editorPid }] } = await editor.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);
      editing = editor.query(`UPDATE services SET price_minor = 100100 WHERE id = $1`, [serviceIds.rct])
        .then(() => ({ error: null }), (error: unknown) => ({ error }));
      await expect.poll(async () => (await observers.query<{ blocked: boolean }>(
        `SELECT $1 = ANY(pg_blocking_pids($2)) AS blocked`, [writerPid, editorPid])).rows[0].blocked,
      { timeout: 5000, interval: 20 }).toBe(true);
      await holder.query("COMMIT");
      const outcome = await writing;
      expect(outcome.error).toBeNull();
      expect(outcome.result).toMatchObject({ ok: true, replayed: false, planId: existing.planId });
      expect((await editing).error).toBeNull();
      await editor.query("ROLLBACK");
      expect(await counts(patient)).toMatchObject({ invoices: 1, plans: 1, items: 2, cases: 1, visits: 4, sessions: 4 });
      expect(await q(`SELECT unit_price_minor::int AS price FROM invoice_items ii
        JOIN invoices v ON v.id = ii.invoice_id WHERE v.patient_id = $1`, [patient])).toEqual([{ price: 100000 }]);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await writing;
      await editing;
      await editor.query("ROLLBACK").catch(() => undefined);
      holder.release();
      editor.release();
      await observers.end();
    }
  });

  it("fails fast against a reverse-order batch writer and releases partial catalogue row locks", async () => {
    const patient = await newPatient("TPL-REVERSE-BATCH");
    const input = await command(patient, selection("ortho", [], true), "tpl:reverse-batch-01");
    const before = await counts(patient);
    const [low, high] = [serviceIds.ortho, serviceIds.records].sort((a, b) => a - b);
    const observers = rawPool();
    const editor = await observers.connect();
    let pending: Promise<{ result: Awaited<ReturnType<typeof save>> | null; error: unknown }> | null = null;
    try {
      await editor.query("BEGIN");
      // Existing batch writers can acquire the higher ID first; the invoice locks selected IDs ascending.
      await editor.query(`SELECT id FROM services WHERE id = $1 FOR UPDATE`, [high]);
      let settled = false;
      pending = save(input).then((result) => ({ result, error: null }), (error: unknown) => ({ result: null, error }))
        .finally(() => { settled = true; });
      await expect.poll(() => settled, { timeout: 5000, interval: 20 }).toBe(true);
      const outcome = await pending;
      expect(outcome.result).toBeNull();
      expect(outcome.error).toBeInstanceOf(InvoiceTemplateBusyError);
      // NOWAIT failure must roll back every earlier SHARE row lock, so the reverse writer can take low immediately.
      await expect(editor.query(`SELECT id FROM services WHERE id = $1 FOR UPDATE NOWAIT`, [low])).resolves.toBeTruthy();
      expect(await counts(patient)).toEqual(before);
      await editor.query("ROLLBACK");
      expect(await save(input)).toMatchObject({ ok: true, replayed: false });
      expect(await counts(patient)).toMatchObject({ invoices: 1, plans: 1, items: 2, visits: 13, sessions: 13 });
    } finally {
      await editor.query("ROLLBACK").catch(() => undefined);
      await pending;
      editor.release();
      await observers.end();
    }
  });

  it("rolls back invoice, plan, cases, schedules and audit writes after a late injected failure", async () => {
    const patient = await newPatient("TPL-ROLLBACK");
    const input = await command(patient, selection("ortho", [], true), "tpl:rollback-00001");
    const before = await counts(patient);
    const audits = await q(`SELECT COUNT(*)::int AS count FROM audit_log`);
    // Runs only inside this isolated PostgreSQL test database. Fail after schedules and case/audit writes.
    await q(`CREATE FUNCTION invoice_template_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected invoice-template write failure'; END; $$`);
    try {
      await q(`CREATE TRIGGER invoice_template_test_failure BEFORE INSERT ON invoice_items
        FOR EACH ROW EXECUTE FUNCTION invoice_template_test_failure()`);
      await expect(save(input)).rejects.toThrow("injected invoice-template write failure");
    } finally {
      await q(`DROP TRIGGER IF EXISTS invoice_template_test_failure ON invoice_items`);
      await q(`DROP FUNCTION IF EXISTS invoice_template_test_failure()`);
    }
    expect(await counts(patient)).toEqual(before);
    expect(await q(`SELECT COUNT(*)::int AS count FROM audit_log`)).toEqual(audits);
    expect(await scheduleSnapshot(patient)).toEqual([]);
    const retried = await save(input);
    expect(retried).toMatchObject({ ok: true, replayed: false });
    expect(await counts(patient)).toMatchObject({ invoices: 1, plans: 1, items: 2, cases: 1, visits: 13, sessions: 13 });
  });

  it.each(["endo", "records"] as const)("invoice-covered %s sessions remain zero-priced and produce no second invoice", async (kind) => {
    const patient = await newPatient(`TPL-COVERED-${kind}`);
    const input = await command(patient, kind === "endo" ? selection("endo", [36]) : selection("ortho", [], true));
    const created = await save(input);
    if (!created.ok) throw new Error(created.reason);
    expect(await db.recordPlanConsent({ planId: created.planId!, actor: "reception", note: "Explicit clinical consent" })).toMatchObject({ ok: true });
    const item = input.items[0];
    const visit = await db.addVisit({ patientId: patient, patientName: "Template patient", patientPhone: null, note: null, doctorId: doctor });
    expect(await db.setVisitProcedures({ visitId: visit.id, procedures: [{
      serviceId: item.serviceId!, toothCode: item.toothCode, surfaces: item.surfaces ?? null,
      quantity: 1, unitPriceMinor: 100_000, priceReason: null, doctorId: doctor, note: null,
      planItemId: created.links[0].planItemId,
    }] })).toBe(true);
    const billing = await db.previewVisitBilling(visit.id);
    expect(billing?.lines).toHaveLength(1);
    expect(billing?.lines[0]).toMatchObject({ amountMinor: 0, planLinked: true });
    expect(billing?.lines[0].classification).not.toBe("NEW_BILLABLE");
    expect(billing?.duesByCurrency).toEqual({});
    expect(await db.signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "doctor", signerDoctorPartyId: doctor }))
      .toMatchObject({ reason: null, invoiceId: null, sessionsCompleted: 1 });
    expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patient])).toEqual([{ id: created.invoice.id }]);
    expect(await q(`SELECT COUNT(*)::int AS done FROM treatment_sessions WHERE plan_item_id = $1 AND status = 'done'`, [created.links[0].planItemId]))
      .toEqual([{ done: 1 }]);
  });
});

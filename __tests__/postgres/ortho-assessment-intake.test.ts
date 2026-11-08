import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ORTHO_ASSESSMENT_INTAKE_SQL } from "../../lib/ortho-assessment-intake-schema";
import { runBaselineSchemaProbe } from "../../lib/baseline-probe";
vi.mock("server-only", () => ({}));
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createSessionToken, sessionCredentialVersion, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { openOrthoAssessment, startOrthoTreatment } from "../../lib/ortho-assessment-intake-store";
import { verifyIntakeReceipt } from "../../lib/ortho-assessment-intake";
const request = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "aqlan_flow_session" ? { value: request.token } : undefined }), headers: async () => new Headers() }));
let f: Awaited<ReturnType<typeof openPeriodontalFixture>>, session: SessionPayload;
beforeAll(async () => { f = await openPeriodontalFixture(process.env, { pristine: true }); await f.db.ensureSchema(); const password = "synthetic-intake-credential", u = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role) VALUES('intake-admin','Synthetic intake clinician',$1,'admin') RETURNING id", [password])).rows[0]; session = { userId: u.id, username: "intake-admin", role: "admin", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 }; request.token = createSessionToken(session); });
afterAll(async () => { await f?.close(); });
const command = () => ({ schemaVersion: 1 as const, clientRequestId: randomUUID(), reason: "Synthetic diagnostic intake" });
const patient = async () => (await f.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic new diagnostic case') RETURNING id", [randomUUID()])).rows[0].id;
const unrelated = async () => (await f.pool.query("SELECT (SELECT count(*)::int FROM treatment_plans) plans,(SELECT count(*)::int FROM plan_items) plan_items,(SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM payments) payments,(SELECT count(*)::int FROM patient_opening_balances) opening,(SELECT count(*)::int FROM visits) visits,(SELECT count(*)::int FROM appointments) appointments")).rows;
describe("diagnostic case identity before actual treatment", () => {
    it("permits synthetic reset when all durable intake command history is empty", async () => {
        expect(await f.db.resetClinicData({ actor: session.username, actorRole: session.role }, async () => ({ ok: true as const, backupId: "synthetic-empty-intake-reset" }))).toMatchObject({ ok: true });
    });
    it("refuses reset and direct truncation once intake command history exists", async () => {
        const patientId = await patient(), cmd = command();
        const saved = await openOrthoAssessment({ patientId, session, command: cmd });
        expect(saved).toMatchObject({ ok: true });
        const backup = vi.fn(async () => ({ ok: false as const, failure: "Synthetic backup intentionally refused" }));
        await expect(f.db.resetClinicData({ actor: session.username, actorRole: session.role }, backup)).rejects.toMatchObject({ name: "ProtectedOrthoIntakeHistoryError" });
        expect(backup).not.toHaveBeenCalled();
        const client = await f.pool.connect();
        try {
            await client.query("BEGIN");
            await expect(client.query("TRUNCATE ortho_case_intake_events")).rejects.toThrow("append-only");
        } finally { await client.query("ROLLBACK"); client.release(); }
        expect(await openOrthoAssessment({ patientId, session, command: cmd })).toEqual({ ...saved, mode: "replayed" });
    });
    it("registers exact migration bytes and permits only the guarded baseline evolution", async () => {
        expect(readFileSync("migrations/0108_ortho_assessment_intake.sql", "utf8")).toBe(ORTHO_ASSESSMENT_INTAKE_SQL);
        expect((await f.pool.query("SELECT checksum,adopted FROM schema_migrations WHERE version='0108'")).rows).toEqual([{ checksum: createHash("sha256").update(ORTHO_ASSESSMENT_INTAKE_SQL).digest("hex"), adopted: false }]);
        const { loadMigrationFiles } = await import("../../lib/migration-files");
        expect((await runBaselineSchemaProbe(f.pool, (await loadMigrationFiles())[0].sql)).ok).toBe(true);
    });
    it("fails baseline verification if intake provenance or its replacement lifecycle constraint drifts", async () => {
        const { loadMigrationFiles } = await import("../../lib/migration-files");
        const baseline = (await loadMigrationFiles())[0].sql;
        const checksum = createHash("sha256").update(ORTHO_ASSESSMENT_INTAKE_SQL).digest("hex");
        await f.pool.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0108'", ["0".repeat(64)]);
        try { expect((await runBaselineSchemaProbe(f.pool, baseline)).ok).toBe(false); }
        finally { await f.pool.query("UPDATE schema_migrations SET checksum=$1 WHERE version='0108'", [checksum]); }
        const replacement = ORTHO_ASSESSMENT_INTAKE_SQL.match(/ALTER TABLE ortho_cases ADD CONSTRAINT ortho_assessment_state_check CHECK \([\s\S]*?\n\);/)?.[0];
        if (!replacement) throw Error("Missing exact lifecycle replacement constraint");
        await f.pool.query("ALTER TABLE ortho_cases DROP CONSTRAINT ortho_assessment_state_check");
        try { expect((await runBaselineSchemaProbe(f.pool, baseline)).ok).toBe(false); }
        finally { await f.pool.query(replacement); }
        expect((await runBaselineSchemaProbe(f.pool, baseline)).ok).toBe(true);
    });
    it("creates one linked case with no assumed treatment facts, replays and reopens its identity", async () => {
        const patientId = await patient(), cmd = command(), before = await unrelated();
        const saved = await openOrthoAssessment({ patientId, session, command: cmd });
        expect(saved).toMatchObject({ ok: true, mode: "created" });
        if (!saved.ok)
            throw Error(saved.code);
        await expect(verifyIntakeReceipt(saved, { patientId, actorId: session.userId!, command: cmd }, 201)).resolves.toEqual(saved);
        expect((await f.pool.query("SELECT status,phase,appliance,arches,slot,start_date,planned_months,plan_id FROM ortho_cases WHERE id=$1", [saved.orthoCaseId])).rows[0]).toEqual({ status: "assessment", phase: "assessment", appliance: null, arches: null, slot: null, start_date: null, planned_months: null, plan_id: null });
        expect(await openOrthoAssessment({ patientId, session, command: cmd })).toEqual({ ...saved, mode: "replayed" });
        expect(await openOrthoAssessment({ patientId, session, command: command() })).toMatchObject({ ok: true, mode: "existing", orthoCaseId: saved.orthoCaseId, clinicalCaseId: saved.clinicalCaseId });
        expect(await openOrthoAssessment({ patientId, session, command: { ...cmd, reason: "different" } })).toMatchObject({ ok: false, code: "request_key_conflict" });
        const cases = await f.db.listPatientOrthoCases(patientId, "2026-11-03");
        expect(cases).toHaveLength(1);
        expect(cases[0]).toMatchObject({ id: saved.orthoCaseId, status: "assessment", progress: null, startDate: null });
        expect((await f.db.listPatientCases(patientId))[0]).toMatchObject({ id: saved.clinicalCaseId, orthoCaseId: saved.orthoCaseId, status: "active" });
        expect(await unrelated()).toEqual(before);
    });
    it("serializes two entry points without duplicate cases or bridges", async () => {
        const patientId = await patient();
        const replies = await Promise.all([openOrthoAssessment({ patientId, session, command: command() }), openOrthoAssessment({ patientId, session, command: command() })]);
        expect(replies.every(r => r.ok)).toBe(true);
        if (!replies[0].ok || !replies[1].ok)
            throw Error("unexpected");
        expect(replies[0].orthoCaseId).toBe(replies[1].orthoCaseId);
        expect(replies.map(r => r.ok ? r.mode : "failed").sort()).toEqual(["created", "existing"]);
        expect((await f.pool.query("SELECT count(*)::int n FROM clinical_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(1);
    });
    it("starts treatment explicitly on the same case; exact retry does not recreate or reopen", async () => {
        const patientId = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok)
            throw Error(opened.code);
        const before = await unrelated(), cmd = { ...command(), confirmed: true as const, appliance: "aligners" as const, arches: "upper" as const, slot: null, startDate: "2026-10-01", plannedMonths: 12, bracketSystem: "" }, owner = { patientId, session, orthoCaseId: opened.orthoCaseId };
        const saved = await startOrthoTreatment({ ...owner, command: cmd });
        expect(saved).toMatchObject({ ok: true, mode: "started", orthoCaseId: opened.orthoCaseId, clinicalCaseId: opened.clinicalCaseId });
        expect(await startOrthoTreatment({ ...owner, command: cmd })).toMatchObject({ ok: true, mode: "replayed" });
        expect(await startOrthoTreatment({ ...owner, command: { ...cmd, clientRequestId: randomUUID() } })).toMatchObject({ ok: false, status: 409 });
        expect(await unrelated()).toEqual(before);
        expect((await f.db.listPatientOrthoCases(patientId, "2026-11-03"))[0]).toMatchObject({ status: "active", appliance: "aligners", slot: null, startDate: "2026-10-01" });
        await f.pool.query("UPDATE ortho_cases SET status='completed',closed_at=now() WHERE id=$1", [opened.orthoCaseId]);
        expect(await startOrthoTreatment({ ...owner, command: cmd })).toMatchObject({ ok: true, mode: "replayed" });
        expect((await f.pool.query("SELECT status FROM ortho_cases WHERE id=$1", [opened.orthoCaseId])).rows[0].status).toBe("completed");
    });
    it("composes explicit start with durable adjustment replay and closed-case write refusal", async () => {
        const patientId = await patient(), openCommand = command();
        const opened = await openOrthoAssessment({ patientId, session, command: openCommand });
        if (!opened.ok) throw Error(opened.code);
        const before = await unrelated();
        const adjustment = { caseId: opened.orthoCaseId, visitId: null, doneOn: "2026-10-02",
            phase: null, upperWire: null, lowerWire: null, elastics: "none" as const,
            elasticNote: null, done: "Synthetic cross-flow adjustment", nextWeeks: 4, note: null,
            recordedBy: session.username, actorRole: session.role,
            request: { key: randomUUID(), patientId, session } };
        expect(await f.db.recordAdjustment(adjustment)).toMatchObject({ ok: false, message: expect.stringContaining("لم يبدأ العلاج") });
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_adjustment_requests WHERE case_id=$1", [opened.orthoCaseId])).rows[0].n).toBe(0);
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_adjustments WHERE case_id=$1", [opened.orthoCaseId])).rows[0].n).toBe(0);
        const startCommand = { ...command(), confirmed: true as const, appliance: "aligners" as const,
            arches: "upper" as const, slot: null, startDate: "2026-10-01", plannedMonths: 12, bracketSystem: "" };
        const startOwner = { patientId, session, orthoCaseId: opened.orthoCaseId };
        expect(await startOrthoTreatment({ ...startOwner, command: startCommand })).toMatchObject({ ok: true, mode: "started" });
        const saved = await f.db.recordAdjustment(adjustment);
        expect(saved).toMatchObject({ ok: true, created: true, visitId: null });
        if (!saved.ok) throw Error(saved.message);
        await f.pool.query("UPDATE ortho_cases SET status='completed',closed_at=now() WHERE id=$1", [opened.orthoCaseId]);
        expect(await f.db.recordAdjustment(adjustment)).toMatchObject({ ok: true, created: false, replayed: true, id: saved.id });
        expect(await f.db.recordAdjustment({ ...adjustment, request: { ...adjustment.request, key: randomUUID() } })).toMatchObject({ ok: false });
        expect(await startOrthoTreatment({ ...startOwner, command: startCommand })).toMatchObject({ ok: true, mode: "replayed" });
        expect(await openOrthoAssessment({ patientId, session, command: openCommand })).toMatchObject({ ok: true, mode: "replayed", orthoCaseId: opened.orthoCaseId });
        expect((await f.pool.query("SELECT status FROM ortho_cases WHERE id=$1", [opened.orthoCaseId])).rows[0].status).toBe("completed");
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_adjustments WHERE case_id=$1", [opened.orthoCaseId])).rows[0].n).toBe(1);
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_adjustment_requests WHERE case_id=$1", [opened.orthoCaseId])).rows[0].n).toBe(1);
        expect(await unrelated()).toEqual(before);
    });
    it("blocks unlinked existing shells and audit failure without creating a second context", async () => {
        const patientId = await patient();
        await f.pool.query("INSERT INTO clinical_cases(patient_id,specialty,title,created_by) VALUES($1,'orthodontics','Synthetic existing shell','synthetic')", [patientId]);
        expect(await openOrthoAssessment({ patientId, session, command: command() })).toMatchObject({ ok: false, code: "unlinked_ortho_case" });
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(0);
        const empty = await patient();
        await f.pool.query("CREATE FUNCTION synthetic_intake_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='ortho.assessment_open' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_intake_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_intake_audit_fail()");
        try {
            await expect(openOrthoAssessment({ patientId: empty, session, command: command() })).rejects.toThrow("synthetic audit failure");
        }
        finally {
            await f.pool.query("DROP TRIGGER synthetic_intake_audit_fail ON audit_log;DROP FUNCTION synthetic_intake_audit_fail()");
        }
        expect((await f.pool.query("SELECT count(*)::int n FROM clinical_cases WHERE patient_id=$1", [empty])).rows[0].n).toBe(0);
    });
    it("permits a clinician without finance rights, but rejects reception and stale credentials", async () => {
        const password = "synthetic-intake-doctor-credential";
        const user = (await f.pool.query("INSERT INTO users(username,display_name,password_hash,role,permissions) VALUES('intake-doctor','Synthetic doctor',$1,'doctor',$2) RETURNING id", [password, JSON.stringify({ canViewAllPatients: true, canViewPlans: false, canEditPlans: false })])).rows[0];
        const doctor: SessionPayload = { userId: user.id, username: "intake-doctor", role: "doctor", credentialVersion: sessionCredentialVersion(password), expiresAt: Date.now() + 3600000 };
        request.token = createSessionToken(doctor);
        try {
            const patientId = await patient();
            expect(await openOrthoAssessment({ patientId, session: doctor, command: command() })).toMatchObject({ ok: true, actorId: user.id });
            await f.pool.query("UPDATE users SET permissions=$2 WHERE id=$1", [user.id, JSON.stringify({ canViewAllPatients: false, canViewPlans: false, canEditPlans: false })]);
            expect(await openOrthoAssessment({ patientId, session: doctor, command: command() })).toMatchObject({ ok: false, status: 403, code: "patient_access_denied" });
            await f.pool.query("UPDATE users SET role='reception' WHERE id=$1", [user.id]);
            const reception: SessionPayload = { ...doctor, role: "reception" };
            request.token = createSessionToken(reception);
            expect(await openOrthoAssessment({ patientId, session: reception, command: command() })).toMatchObject({ ok: false, status: 403 });
            await f.pool.query("UPDATE users SET password_hash='synthetic-changed-credential' WHERE id=$1", [user.id]);
            expect(await openOrthoAssessment({ patientId, session: reception, command: command() })).toMatchObject({ ok: false, status: 401 });
        }
        finally {
            request.token = createSessionToken(session);
        }
    });
    it("refuses foreign scope and future dates, and serializes competing treatment starts", async () => {
        const patientId = await patient(), other = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok)
            throw Error(opened.code);
        const cmd = { ...command(), confirmed: true as const, appliance: "fixed_metal" as const, arches: "both" as const, slot: "022" as const, startDate: "2026-10-01", plannedMonths: 18, bracketSystem: "" }, owner = { patientId, session, orthoCaseId: opened.orthoCaseId };
        expect(await startOrthoTreatment({ ...owner, patientId: other, command: cmd })).toMatchObject({ ok: false, status: 404 });
        expect(await startOrthoTreatment({ ...owner, command: { ...cmd, startDate: "2999-01-01" } })).toMatchObject({ ok: false, status: 400 });
        const results = await Promise.all([startOrthoTreatment({ ...owner, command: cmd }), startOrthoTreatment({ ...owner, command: { ...cmd, clientRequestId: randomUUID() } })]);
        expect(results.filter(r => r.ok)).toHaveLength(1);
        expect(results.find(r => !r.ok)).toMatchObject({ status: 409 });
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_case_intake_events WHERE ortho_case_id=$1 AND event_kind='treatment_started'", [opened.orthoCaseId])).rows[0].n).toBe(1);
    });
    it("replays an existing-case receipt after completion instead of opening a second identity", async () => {
        const patientId = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok) throw Error(opened.code);
        const retry = command();
        expect(await openOrthoAssessment({ patientId, session, command: retry })).toMatchObject({ mode: "existing", orthoCaseId: opened.orthoCaseId });
        await f.pool.query("UPDATE ortho_cases SET status='discontinued',closed_at=now() WHERE id=$1", [opened.orthoCaseId]);
        expect(await openOrthoAssessment({ patientId, session, command: retry })).toMatchObject({ mode: "replayed", orthoCaseId: opened.orthoCaseId });
        expect(await openOrthoAssessment({ patientId, session, command: { ...retry, reason: "changed request" } })).toMatchObject({ ok: false, code: "request_key_conflict" });
        expect((await f.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(1);
    });
    it("keeps the clinical bridge's treatment site consistent without silently changing existing scope", async () => {
        const patientId = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok) throw Error(opened.code);
        const cmd = { ...command(), confirmed: true as const, appliance: "fixed_metal" as const, arches: "both" as const, slot: "022" as const, startDate: "2026-10-01", plannedMonths: 18, bracketSystem: "" };
        const owner = { patientId, session, orthoCaseId: opened.orthoCaseId };
        await f.pool.query("UPDATE clinical_cases SET site='upper' WHERE id=$1", [opened.clinicalCaseId]);
        expect(await startOrthoTreatment({ ...owner, command: cmd })).toMatchObject({ ok: false, code: "treatment_scope_conflict" });
        await f.pool.query("UPDATE clinical_cases SET site=NULL WHERE id=$1", [opened.clinicalCaseId]);
        expect(await startOrthoTreatment({ ...owner, command: cmd })).toMatchObject({ ok: true });
        const { SITE_SCOPE_LABEL } = await import("../../lib/invoice-clinical-linkage");
        expect((await f.pool.query("SELECT site FROM clinical_cases WHERE id=$1", [opened.clinicalCaseId])).rows[0].site).toBe(SITE_SCOPE_LABEL.both);
    });
    it("refuses a new adjustment before explicit treatment start even with null phase and wires", async () => {
        const patientId = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok) throw Error(opened.code);
        const before = await unrelated();
        const row = (await f.pool.query("SELECT * FROM ortho_cases WHERE id=$1", [opened.orthoCaseId])).rows[0];
        const audit = (await f.pool.query("SELECT count(*)::int n FROM audit_log")).rows[0].n;
        const saved = await f.db.recordAdjustment({ caseId: opened.orthoCaseId, visitId: null, doneOn: "2026-10-01", phase: null, upperWire: null, lowerWire: null, elastics: "none", elasticNote: null, done: "Synthetic premature adjustment", nextWeeks: 4, note: null, recordedBy: "Synthetic intake clinician", actorRole: "admin" });
        expect(saved).toMatchObject({ ok: false, message: "لم يبدأ العلاج بعد — وثّق بدء العلاج قبل تسجيل شدّة." });
        expect((await f.pool.query("SELECT * FROM ortho_cases WHERE id=$1", [opened.orthoCaseId])).rows[0]).toEqual(row);
        expect((await f.pool.query("SELECT id FROM ortho_adjustments WHERE case_id=$1", [opened.orthoCaseId])).rows).toEqual([]);
        expect((await f.pool.query("SELECT count(*)::int n FROM audit_log")).rows[0].n).toBe(audit);
        expect(await unrelated()).toEqual(before);
    });
    it("preserves intake provenance and exact replay through canonical duplicate-patient merge", async () => {
        const patientId = await patient(), target = await patient(), cmd = command();
        const opened = await openOrthoAssessment({ patientId, session, command: cmd });
        if (!opened.ok) throw Error(opened.code);
        expect(await f.db.mergeDuplicatePatient(patientId, target, { actor: "Synthetic intake clinician", actorRole: "admin", reason: "Synthetic duplicate reconciliation" })).toMatchObject({ ok: true });
        expect(await openOrthoAssessment({ patientId: target, session, command: cmd })).toMatchObject({ ok: true, mode: "replayed", patientId: target, orthoCaseId: opened.orthoCaseId });
        expect((await f.pool.query("SELECT patient_id,recorded_patient_id,request_fingerprint,command FROM ortho_case_intake_events WHERE ortho_case_id=$1", [opened.orthoCaseId])).rows[0]).toMatchObject({ patient_id: target, recorded_patient_id: patientId, request_fingerprint: opened.requestFingerprint, command: cmd });
        await expect(f.pool.query("UPDATE ortho_case_intake_events SET recorded_patient_id=$2 WHERE ortho_case_id=$1", [opened.orthoCaseId, target])).rejects.toThrow("append-only");
        await expect(f.pool.query("UPDATE ortho_case_intake_events SET patient_id=$2 WHERE ortho_case_id=$1", [opened.orthoCaseId, await patient()])).rejects.toThrow("ownership must match");
    });
    it("keeps events immutable, scope fixed and treatment facts absent until an explicit start", async () => {
        const patientId = await patient(), other = await patient(), opened = await openOrthoAssessment({ patientId, session, command: command() });
        if (!opened.ok)
            throw Error(opened.code);
        await expect(f.pool.query("UPDATE ortho_case_intake_events SET command='{}' WHERE ortho_case_id=$1", [opened.orthoCaseId])).rejects.toThrow("append-only");
        await expect(f.pool.query("DELETE FROM ortho_case_intake_events WHERE ortho_case_id=$1", [opened.orthoCaseId])).rejects.toThrow("append-only");
        await expect(f.pool.query("UPDATE ortho_cases SET patient_id=$2 WHERE id=$1", [opened.orthoCaseId, other])).rejects.toThrow();
        await expect(f.pool.query("UPDATE clinical_cases SET patient_id=$2 WHERE id=$1", [opened.clinicalCaseId, other])).rejects.toThrow();
        await expect(f.pool.query("UPDATE ortho_cases SET start_date=current_date WHERE id=$1", [opened.orthoCaseId])).rejects.toThrow("ortho_assessment_state_check");
        await expect(f.pool.query("UPDATE ortho_cases SET status='active',phase='aligning' WHERE id=$1", [opened.orthoCaseId])).rejects.toThrow("ortho_assessment_state_check");
    });
});

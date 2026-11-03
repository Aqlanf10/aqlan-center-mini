/** Slice 39: Canonical Administration, Reports, Settings, Self-Service & Owner-Only Admission on real PostgreSQL 18. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import {
  openCanonicalInventoryDatabase,
  type CanonicalInventoryDatabase,
} from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-slice39-admin-reports-settings-20261101");

const tempDocsDir = mkdtempSync(join(tmpdir(), "syn-slice39-docs-"));
vi.stubEnv("DOCUMENTS_DIR", tempDocsDir);

const db = await import("../../lib/db");
const { hashPassword, SESSION_COOKIE } = await import("../../lib/auth");
const { STAFF_CAPABILITIES } = await import("../../lib/staff-capability-catalogue");
const { staffRuntimeActions } = await import("../../lib/staff-operation-runtime");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const { readVerifiedDurableSession } = await import("../../lib/staff-durable-session");
const usersSelf = await import("../../lib/canonical-users-self");
const adminReports = await import("../../lib/canonical-admin-reports-settings");
const savedReports = await import("../../lib/canonical-saved-reports");
const backupReadonly = await import("../../lib/canonical-backup-readonly");
const ownerOps = await import("../../lib/canonical-owner-ops");

const ALL_DELEGABLE_GRANTS = Object.fromEntries(
  STAFF_CAPABILITIES.map((cap) => [cap, true]),
) as Record<string, boolean>;

const ACCOUNTS = {
  owner: {
    username: "SYN-S39-OWNER",
    role: "admin",
    patientScope: "all",
    appointmentScope: "all",
    grants: ALL_DELEGABLE_GRANTS,
  },
  superDelegate: {
    username: "SYN-S39-DELEGATE",
    role: "admin",
    patientScope: "all",
    appointmentScope: "all",
    grants: ALL_DELEGABLE_GRANTS,
  },
  staffViewer: {
    username: "SYN-S39-STAFF-VIEW",
    role: "reception",
    grants: {
      "staff.view": true,
    },
  },
  opsViewer: {
    username: "SYN-S39-OPS-VIEW",
    role: "reception",
    patientScope: "all",
    appointmentScope: "all",
    grants: {
      "reports.operational.view": true,
      "settings.view": true,
      "audit.view": true,
    },
  },
  opsFinanceViewer: {
    username: "SYN-S39-OPS-FIN",
    role: "accountant",
    patientScope: "all",
    appointmentScope: "all",
    grants: {
      "reports.operational.view": true,
      "reports.financial.view": true,
      "finance.payments.view": true,
      "finance.patient-ledger.view": true,
      "finance.opening-balances.manage": true,
    },
  },
  ownDoctor: {
    username: "SYN-S39-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "reports.operational.view": true,
      "finance.commissions.view-own": true,
      "clinical.visits.document": true,
    },
  },
  otherDoctor: {
    username: "SYN-S39-DOC-OTHER",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "clinical.visits.document": true,
    },
  },
  pwUser: {
    username: "SYN-S39-PW-USER",
    role: "reception",
    grants: {
      "settings.view": true,
    },
  },
} as const;

type Key = keyof typeof ACCOUNTS;

let fx: CanonicalInventoryDatabase<Key>;

const ids = {
  ownPatientId: 0,
  otherPatientId: 0,
  privateTaskId: 0,
};

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      host: "localhost:3010",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function extractCookieToken(setCookieHeader: string | null, cookieName: string): string | null {
  if (!setCookieHeader) return null;
  const prefix = `${cookieName}=`;
  for (const part of setCookieHeader.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length).split(";")[0] ?? null;
    }
  }
  return null;
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");

  // Seed real password hash on pwUser so self-service password rotation can verify & rotate it.
  const initialHash = await hashPassword("InitialPass!2026");
  await fx.pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [
    initialHash,
    fx.ids.pwUser,
  ]);

  ids.ownPatientId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-S39-P1','SYN Own Patient','777390001',$1) RETURNING id",
      [fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.otherPatientId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-S39-P2','SYN Other Patient','777390002',$1) RETURNING id",
      [fx.parties.otherDoctor!],
    )
  ).rows[0].id;

  const today = db.CLINIC_TIME_ZONE
    ? new Intl.DateTimeFormat("en-CA", { timeZone: db.CLINIC_TIME_ZONE }).format(new Date())
    : "2026-11-01";

  await fx.pool.query(
    `INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time,duration_minutes,status)
     VALUES ($1,$2,$3::date,'09:00',30,'confirmed'),
            ($4,$5,$3::date,'10:00',30,'confirmed')`,
    [ids.ownPatientId, fx.parties.ownDoctor!, today, ids.otherPatientId, fx.parties.otherDoctor!],
  );

  // Seed one private HR task + audit row to prove canonicalAuditGet hides private hr_task entries.
  const taskRes = await fx.pool.query<{ id: number }>(
    `INSERT INTO hr_tasks(title,status,priority,is_private,owner_user_id,owner_display_name,created_by)
     VALUES('SYN Private Task','planned','normal',TRUE,$1,'SYN-S39-OWNER','SYN-S39-OWNER') RETURNING id`,
    [fx.ids.owner],
  );
  ids.privateTaskId = taskRes.rows[0].id;
  await fx.pool.query(
    `INSERT INTO audit_log(action,entity,entity_id,summary,actor,actor_role)
     VALUES ('task.create','hr_task',$1,'SYN private task audit','SYN-S39-OWNER','admin'),
            ('patient.create','patient',$2,'SYN public patient audit','SYN-S39-OWNER','admin')`,
    [String(ids.privateTaskId), String(ids.ownPatientId)],
  );
}, 120_000);

afterAll(async () => {
  await fx?.close();
  rmSync(tempDocsDir, { recursive: true, force: true });
});

it("registers 100% of STAFF_CAPABILITIES (122/122) in staffRuntimeActions and read:executive", () => {
  const registered = new Set<string>(staffRuntimeActions());
  const missing = STAFF_CAPABILITIES.filter((cap) => !registered.has(cap));
  expect(missing).toEqual([]);
  expect(STAFF_CAPABILITIES.length).toBe(122);
  expect(CANONICAL_RECORD_READS["read:executive"].anyOf).toEqual([
    "reports.financial.view",
    "finance.commissions.view-own",
  ]);
});

it("enforces canonical /api/users projection, B2 ready guard on POST, and owner/delegate boundaries on PATCH /api/users/[id]", async () => {
  // 1. Denied without staff.view
  const deniedGet = await usersSelf.canonicalUsersGet(await fx.session("ownDoctor"));
  expect(deniedGet.status).toBe(403);

  // 2. staffViewer (staff.view only): omits passwordHash, permissions, AND commissionConfig; projects isOwner accurately
  const viewerRes = await usersSelf.canonicalUsersGet(await fx.session("staffViewer"));
  expect(viewerRes.status).toBe(200);
  const viewerRows = (await viewerRes.json()) as Array<Record<string, unknown>>;
  const ownerRow = viewerRows.find((r) => r.id === fx.ids.owner)!;
  const delegateRow = viewerRows.find((r) => r.id === fx.ids.superDelegate)!;
  expect(ownerRow.isOwner).toBe(true);
  expect(delegateRow.isOwner).toBe(false);
  expect("passwordHash" in ownerRow).toBe(false);
  expect("permissions" in ownerRow).toBe(false);
  expect("commissionConfig" in ownerRow).toBe(false);

  // 3. superDelegate (holds finance.commissions.view-all): sees commissionConfig
  const fullRes = await usersSelf.canonicalUsersGet(await fx.session("superDelegate"));
  expect(fullRes.status).toBe(200);
  const fullRows = (await fullRes.json()) as Array<Record<string, unknown>>;
  expect("commissionConfig" in fullRows[0]!).toBe(true);

  // 4. POST /api/users: 403 without grant, 409 ready_identity_account_create_requires_b2 when ready
  const deniedPost = await usersSelf.canonicalUsersPost(
    await fx.session("staffViewer"),
    jsonReq("http://localhost:3010/api/users", "POST", {
      username: "syn_new_staff",
      displayName: "SYN New Staff",
      password: "ValidPassword123!",
      role: "reception",
    }),
  );
  expect(deniedPost.status).toBe(403);

  const readyBlockedPost = await usersSelf.canonicalUsersPost(
    await fx.session("owner"),
    jsonReq("http://localhost:3010/api/users", "POST", {
      username: "syn_new_staff",
      displayName: "SYN New Staff",
      password: "ValidPassword123!",
      role: "reception",
    }),
  );
  expect(readyBlockedPost.status).toBe(409);
  expect((await readyBlockedPost.json()).code).toBe("ready_identity_account_create_requires_b2");

  // 5. PATCH /api/users/[id]: rejects legacy permissions JSON
  const legacyPermPatch = await usersSelf.canonicalUsersPatch(
    await fx.session("owner"),
    jsonReq(`http://localhost:3010/api/users/${fx.ids.staffViewer}`, "PATCH", {
      permissions: { canViewAllPatients: true },
    }),
    String(fx.ids.staffViewer),
  );
  expect(legacyPermPatch.status).toBe(409);
  expect((await legacyPermPatch.json()).code).toBe("legacy_permissions_not_canonical");

  // 6. Delegate CAN edit displayName of subordinate, CANNOT change role/password/link_doctor, CANNOT edit owner or self
  const delegateProfileOk = await usersSelf.canonicalUsersPatch(
    await fx.session("superDelegate"),
    jsonReq(`http://localhost:3010/api/users/${fx.ids.staffViewer}`, "PATCH", {
      displayName: "SYN Updated Viewer",
    }),
    String(fx.ids.staffViewer),
  );
  expect(delegateProfileOk.status).toBe(200);
  expect((await delegateProfileOk.json()).displayName).toBe("SYN Updated Viewer");

  const delegateRoleForbidden = await usersSelf.canonicalUsersPatch(
    await fx.session("superDelegate"),
    jsonReq(`http://localhost:3010/api/users/${fx.ids.staffViewer}`, "PATCH", {
      role: "cashier",
    }),
    String(fx.ids.staffViewer),
  );
  expect(delegateRoleForbidden.status).toBe(403);

  const delegateLinkForbidden = await usersSelf.canonicalUsersPatch(
    await fx.session("superDelegate"),
    jsonReq(`http://localhost:3010/api/users/${fx.ids.staffViewer}`, "PATCH", {
      action: "link_doctor",
      partyId: fx.parties.ownDoctor!,
    }),
    String(fx.ids.staffViewer),
  );
  expect(delegateLinkForbidden.status).toBe(403);

  const delegateTouchOwner = await usersSelf.canonicalUsersPatch(
    await fx.session("superDelegate"),
    jsonReq(`http://localhost:3010/api/users/${fx.ids.owner}`, "PATCH", {
      displayName: "Attempted Owner Rename",
    }),
    String(fx.ids.owner),
  );
  expect(delegateTouchOwner.status).toBe(403);

  const delegateTouchSelf = await usersSelf.canonicalUsersPatch(
    await fx.session("superDelegate"),
    jsonReq(`http://localhost:3010/api/users/${fx.ids.superDelegate}`, "PATCH", {
      displayName: "Attempted Self Edit",
    }),
    String(fx.ids.superDelegate),
  );
  expect(delegateTouchSelf.status).toBe(403);

  // 7. Protected owner deactivates target -> target's pre-existing durable session is immediately revoked (401)!
  const staleViewerSession = await fx.session("staffViewer");
  const ownerDisable = await usersSelf.canonicalUsersPatch(
    await fx.session("owner"),
    jsonReq(`http://localhost:3010/api/users/${fx.ids.staffViewer}`, "PATCH", {
      isActive: false,
    }),
    String(fx.ids.staffViewer),
  );
  expect(ownerDisable.status).toBe(200);

  const afterDisableUse = await usersSelf.canonicalUsersGet(staleViewerSession);
  expect(afterDisableUse.status).toBe(401);

  // Re-activate staffViewer
  const ownerEnable = await usersSelf.canonicalUsersPatch(
    await fx.session("owner"),
    jsonReq(`http://localhost:3010/api/users/${fx.ids.staffViewer}`, "PATCH", {
      isActive: true,
    }),
    String(fx.ids.staffViewer),
  );
  expect(ownerEnable.status).toBe(200);
});

it("rotates self password with prior-session revocation, projects opening-balance access, and audits document reprints", async () => {
  // 1. Opening balances access projection
  const noObRes = await usersSelf.canonicalOpeningBalancesAccessGet(await fx.session("opsViewer"));
  expect(await noObRes.json()).toEqual({ add: false, edit: false });

  const yesObRes = await usersSelf.canonicalOpeningBalancesAccessGet(await fx.session("opsFinanceViewer"));
  expect(await yesObRes.json()).toEqual({ add: true, edit: true });

  // 2. Self password change on pwUser
  const oldPwSession = await fx.session("pwUser");
  const wrongPwRes = await usersSelf.canonicalAuthPasswordPost(
    oldPwSession,
    jsonReq("http://localhost:3010/api/auth/password", "POST", {
      currentPassword: "WrongPassword!999",
      newPassword: "UpdatedPass!2026",
    }),
  );
  expect(wrongPwRes.status).toBe(403);

  const okPwRes = await usersSelf.canonicalAuthPasswordPost(
    oldPwSession,
    jsonReq("http://localhost:3010/api/auth/password", "POST", {
      currentPassword: "InitialPass!2026",
      newPassword: "UpdatedPass!2026",
    }),
  );
  expect(okPwRes.status).toBe(200);
  const newToken = extractCookieToken(okPwRes.headers.get("set-cookie"), SESSION_COOKIE);
  expect(newToken).toBeTruthy();
  const newHandle = readVerifiedDurableSession(newToken!);
  expect(newHandle).not.toBeNull();

  // Old durable session is immediately revoked (401), while newly issued cookie works (200)!
  const oldCheck = await usersSelf.canonicalOpeningBalancesAccessGet(oldPwSession);
  expect(oldCheck.status).toBe(401);

  const newCheck = await usersSelf.canonicalOpeningBalancesAccessGet(newHandle!);
  expect(newCheck.status).toBe(200);

  // 3. Print log: first print (reprint=false) and second print (reprint=true + audit row)
  const deniedPrint = await usersSelf.canonicalPrintLogPost(
    await fx.session("opsViewer"),
    jsonReq("http://localhost:3010/api/print-log", "POST", {
      docType: "receipt",
      docId: "SYN-S39-RCPT-1",
    }),
  );
  expect(deniedPrint.status).toBe(403);

  const firstPrint = await usersSelf.canonicalPrintLogPost(
    await fx.session("opsFinanceViewer"),
    jsonReq("http://localhost:3010/api/print-log", "POST", {
      docType: "receipt",
      docId: "SYN-S39-RCPT-1",
    }),
  );
  expect(firstPrint.status).toBe(200);
  expect(await firstPrint.json()).toEqual({ reprint: false, previous: 0 });

  const secondPrint = await usersSelf.canonicalPrintLogPost(
    await fx.session("opsFinanceViewer"),
    jsonReq("http://localhost:3010/api/print-log", "POST", {
      docType: "receipt",
      docId: "SYN-S39-RCPT-1",
    }),
  );
  expect(secondPrint.status).toBe(200);
  expect(await secondPrint.json()).toEqual({ reprint: true, previous: 1 });
});

it("serves canonical audit, executive KPIs/pulse/operations, operational/unified/daily-clinic reports, and saved reports", async () => {
  // 1. Audit hides private hr_task entries
  const auditDenied = await adminReports.canonicalAuditGet(
    await fx.session("ownDoctor"),
    new Request("http://localhost:3010/api/audit"),
  );
  expect(auditDenied.status).toBe(403);

  const auditOk = await adminReports.canonicalAuditGet(
    await fx.session("opsViewer"),
    new Request("http://localhost:3010/api/audit?limit=100"),
  );
  expect(auditOk.status).toBe(200);
  const auditBody = (await auditOk.json()) as { entries: Array<{ entity: string | null; entityId: string | null }> };
  expect(
    auditBody.entries.some((e) => e.entity === "hr_task" && e.entityId === String(ids.privateTaskId)),
  ).toBe(false);
  expect(
    auditBody.entries.some((e) => e.entity === "patient" && e.entityId === String(ids.ownPatientId)),
  ).toBe(true);

  // 2. Executive KPIs: 403 for doctor holding only finance.commissions.view-own; 200 JSON + CSV for financial viewer
  const execDoctorDenied = await adminReports.canonicalExecutiveGet(
    await fx.session("ownDoctor"),
    new Request("http://localhost:3010/api/executive"),
  );
  expect(execDoctorDenied.status).toBe(403);

  const execOk = await adminReports.canonicalExecutiveGet(
    await fx.session("opsFinanceViewer"),
    new Request("http://localhost:3010/api/executive"),
  );
  expect(execOk.status).toBe(200);

  const execCsv = await adminReports.canonicalExecutiveGet(
    await fx.session("opsFinanceViewer"),
    new Request("http://localhost:3010/api/executive?format=csv"),
  );
  expect(execCsv.status).toBe(200);
  expect(execCsv.headers.get("content-type")).toContain("text/csv");

  // 3. Executive operations & pulse require finance.profits.view
  const pulseDenied = await adminReports.canonicalExecutivePulseGet(
    await fx.session("opsFinanceViewer"),
    new Request("http://localhost:3010/api/executive/pulse?view=day"),
  );
  expect(pulseDenied.status).toBe(403);

  const pulseOk = await adminReports.canonicalExecutivePulseGet(
    await fx.session("owner"),
    new Request("http://localhost:3010/api/executive/pulse?view=day"),
  );
  expect(pulseOk.status).toBe(200);

  const opsOverviewOk = await adminReports.canonicalExecutiveOperationsGet(
    await fx.session("owner"),
    new Request("http://localhost:3010/api/executive/operations"),
  );
  expect(opsOverviewOk.status).toBe(200);

  // 4. Operational report (/api/report) scopes appointments by appointmentScope
  const ownReportRes = await adminReports.canonicalOperationalReportGet(
    await fx.session("ownDoctor"),
    new Request("http://localhost:3010/api/report"),
  );
  expect(ownReportRes.status).toBe(200);
  const ownReportBody = await ownReportRes.json();
  expect(ownReportBody.report.booked).toBe(1);

  const allReportRes = await adminReports.canonicalOperationalReportGet(
    await fx.session("opsViewer"),
    new Request("http://localhost:3010/api/report"),
  );
  expect(allReportRes.status).toBe(200);
  const allReportBody = await allReportRes.json();
  expect(allReportBody.report.booked).toBe(2);

  // 5. Unified reports (/api/reports) & Daily clinic closing report (/api/reports/daily-clinic)
  const unifiedOpts = await adminReports.canonicalUnifiedReportsGet(
    await fx.session("opsFinanceViewer"),
    new Request("http://localhost:3010/api/reports?report=options"),
  );
  expect(unifiedOpts.status).toBe(200);

  const dailyDeniedWithoutFinance = await adminReports.canonicalDailyClinicReportGet(
    await fx.session("opsViewer"),
    new Request("http://localhost:3010/api/reports/daily-clinic"),
  );
  expect(dailyDeniedWithoutFinance.status).toBe(403);

  const dailyOk = await adminReports.canonicalDailyClinicReportGet(
    await fx.session("opsFinanceViewer"),
    new Request("http://localhost:3010/api/reports/daily-clinic"),
  );
  expect(dailyOk.status).toBe(200);

  // 6. Saved reports: non-owner cannot share; owner can share
  const nonOwnerList = await savedReports.canonicalSavedReportsGet(await fx.session("opsFinanceViewer"));
  expect(nonOwnerList.status).toBe(200);
  expect((await nonOwnerList.json()).canShare).toBe(false);

  const nonOwnerShareDenied = await savedReports.canonicalSavedReportsPost(
    await fx.session("opsFinanceViewer"),
    jsonReq("http://localhost:3010/api/reports/saved", "POST", {
      name: "SYN Shared Attempt",
      reportId: "daily",
      sectionId: "financial",
      queryString: "report=daily",
      isShared: true,
    }),
  );
  expect(nonOwnerShareDenied.status).toBe(403);

  const privateCreate = await savedReports.canonicalSavedReportsPost(
    await fx.session("opsFinanceViewer"),
    jsonReq("http://localhost:3010/api/reports/saved", "POST", {
      name: "SYN Private Daily",
      reportId: "daily",
      sectionId: "financial",
      queryString: "report=daily",
      isFavorite: true,
    }),
  );
  expect(privateCreate.status).toBe(201);
  const createdSavedId = (await privateCreate.json()).saved.id as number;

  const patchSaved = await savedReports.canonicalSavedReportsPatch(
    await fx.session("opsFinanceViewer"),
    jsonReq("http://localhost:3010/api/reports/saved", "PATCH", {
      id: createdSavedId,
      name: "SYN Private Daily Renamed",
    }),
  );
  expect(patchSaved.status).toBe(200);

  const ownerShareOk = await savedReports.canonicalSavedReportsPost(
    await fx.session("owner"),
    jsonReq("http://localhost:3010/api/reports/saved", "POST", {
      name: "SYN Owner Shared Report",
      reportId: "daily",
      sectionId: "financial",
      queryString: "report=daily",
      isShared: true,
    }),
  );
  expect(ownerShareOk.status).toBe(201);

  const delSaved = await savedReports.canonicalSavedReportsDelete(
    await fx.session("opsFinanceViewer"),
    new Request(`http://localhost:3010/api/reports/saved?id=${createdSavedId}`, { method: "DELETE" }),
  );
  expect(delSaved.status).toBe(200);
});

it("manages canonical operational settings and strictly restricts messaging, backup, export, import, and reset to the protected owner", async () => {
  // 1. Appointment services
  const createSvcDenied = await adminReports.canonicalAppointmentServicesPost(
    await fx.session("opsViewer"),
    jsonReq("http://localhost:3010/api/settings/appointment-services", "POST", {
      code: "syn_consult_39",
      nameAr: "استشارة تجريبية 39",
      specialty: "general",
      defaultDurationMinutes: 25,
    }),
  );
  expect(createSvcDenied.status).toBe(403);

  const createSvcOk = await adminReports.canonicalAppointmentServicesPost(
    await fx.session("superDelegate"),
    jsonReq("http://localhost:3010/api/settings/appointment-services", "POST", {
      code: "syn_consult_39",
      nameAr: "استشارة تجريبية 39",
      specialty: "general",
      defaultDurationMinutes: 25,
    }),
  );
  expect(createSvcOk.status).toBe(201);
  const svcId = (await createSvcOk.json()).id as number;

  const patchSvcOk = await adminReports.canonicalAppointmentServicesPatch(
    await fx.session("superDelegate"),
    jsonReq(`http://localhost:3010/api/settings/appointment-services/${svcId}`, "PATCH", {
      defaultDurationMinutes: 35,
    }),
    String(svcId),
  );
  expect(patchSvcOk.status).toBe(200);

  const listSvcOk = await adminReports.canonicalAppointmentServicesGet(
    await fx.session("opsViewer"),
    new Request("http://localhost:3010/api/settings/appointment-services"),
  );
  expect(listSvcOk.status).toBe(200);

  // 2. Display announcements CRUD + reorder
  const ann1Res = await adminReports.canonicalDisplayAnnouncementsPost(
    await fx.session("superDelegate"),
    jsonReq("http://localhost:3010/api/settings/display/announcements", "POST", {
      title: "SYN Ann 1",
      body: "Welcome 1",
    }),
  );
  expect(ann1Res.status).toBe(201);
  const ann1Id = (await ann1Res.json()).announcement.id as number;

  const ann2Res = await adminReports.canonicalDisplayAnnouncementsPost(
    await fx.session("superDelegate"),
    jsonReq("http://localhost:3010/api/settings/display/announcements", "POST", {
      title: "SYN Ann 2",
      body: "Welcome 2",
    }),
  );
  expect(ann2Res.status).toBe(201);
  const ann2Id = (await ann2Res.json()).announcement.id as number;

  const allAnn = (
    await (await adminReports.canonicalDisplayAnnouncementsGet(await fx.session("opsViewer"))).json()
  ).announcements as Array<{ id: number }>;
  const reorderedIds = [ann2Id, ann1Id, ...allAnn.map((a) => a.id).filter((id) => id !== ann1Id && id !== ann2Id)];

  const reorderRes = await adminReports.canonicalDisplayAnnouncementsReorderPatch(
    await fx.session("superDelegate"),
    jsonReq("http://localhost:3010/api/settings/display/announcements/reorder", "PATCH", {
      ids: reorderedIds,
    }),
  );
  expect(reorderRes.status).toBe(200);

  const delAnnRes = await adminReports.canonicalDisplayAnnouncementsDelete(
    await fx.session("superDelegate"),
    String(ann2Id),
  );
  expect(delAnnRes.status).toBe(200);

  // 3. Material rates, patient numbering, settings history, readiness
  const matPost = await adminReports.canonicalMaterialRatesPost(
    await fx.session("superDelegate"),
    jsonReq("http://localhost:3010/api/settings/material-rates", "POST", {
      category: "general",
      rate: 7.5,
    }),
  );
  expect(matPost.status).toBe(200);

  const matGet = await adminReports.canonicalMaterialRatesGet(await fx.session("opsViewer"));
  expect(matGet.status).toBe(200);

  const numGet = await adminReports.canonicalPatientNumberingGet(await fx.session("superDelegate"));
  expect(numGet.status).toBe(200);
  const numPreview = await numGet.json();
  const numPatch = await adminReports.canonicalPatientNumberingPatch(
    await fx.session("superDelegate"),
    jsonReq("http://localhost:3010/api/settings/patient-numbering", "PATCH", {
      minimumNext: String(Number(numPreview.minimumNext) + 10),
      expectedVersion: numPreview.version,
      expectedNextNumber: numPreview.nextNumber,
      reason: "SYN Slice 39 floor bump",
    }),
  );
  expect(numPatch.status).toBe(200);

  const histGet = await adminReports.canonicalSettingsHistoryGet(
    await fx.session("opsViewer"),
    new Request("http://localhost:3010/api/settings/history?limit=20"),
  );
  expect(histGet.status).toBe(200);

  const readinessGet = await adminReports.canonicalSettingsReadinessGet(await fx.session("opsViewer"));
  expect(readinessGet.status).toBe(200);
  const readinessBody = await readinessGet.json();
  expect(Array.isArray(readinessBody.checks)).toBe(true);
  const backupCheck = readinessBody.checks.find((c: { id: string }) => c.id === "backup_system");
  expect(backupCheck).toMatchObject({ id: "backup_system", status: "warn", actionHref: "/settings/backup" });

  // 4. Owner-only messaging settings: 403 for superDelegate (even with all 113 delegable caps!), 200 for owner
  const msgDelegateDenied = await adminReports.canonicalMessagingSettingsGet(
    await fx.session("superDelegate"),
  );
  expect(msgDelegateDenied.status).toBe(403);

  const msgOwnerOk = await adminReports.canonicalMessagingSettingsGet(await fx.session("owner"));
  expect(msgOwnerOk.status).toBe(200);

  // 5. Owner-only backup readonly admission + clinic reset GET + export GET + SQL backup GET + import preview POST
  const backupDelegate = await backupReadonly.admitCanonicalBackupOwner(
    await fx.session("superDelegate"),
    "Backup owner only.",
  );
  expect("response" in backupDelegate && backupDelegate.response.status).toBe(403);

  const backupOwner = await backupReadonly.admitCanonicalBackupOwner(
    await fx.session("owner"),
    "Backup owner only.",
  );
  expect(backupOwner).toEqual({ username: "SYN-S39-OWNER" });

  const resetDelegate = await ownerOps.canonicalClinicResetGet(await fx.session("superDelegate"));
  expect(resetDelegate.status).toBe(403);

  const resetOwner = await ownerOps.canonicalClinicResetGet(await fx.session("owner"));
  expect(resetOwner.status).toBe(200);

  const exportDelegate = await ownerOps.canonicalExportGet(
    await fx.session("superDelegate"),
    new Request("http://localhost:3010/api/export?table=patients"),
  );
  expect(exportDelegate.status).toBe(403);

  const exportOwner = await ownerOps.canonicalExportGet(
    await fx.session("owner"),
    new Request("http://localhost:3010/api/export?table=patients"),
  );
  expect(exportOwner.status).toBe(200);
  expect(exportOwner.headers.get("content-type")).toContain("text/csv");

  const sqlBackupDelegate = await ownerOps.canonicalBackupSqlGet(await fx.session("superDelegate"));
  expect(sqlBackupDelegate.status).toBe(403);

  const sqlBackupOwner = await ownerOps.canonicalBackupSqlGet(await fx.session("owner"));
  expect(sqlBackupOwner.status).toBe(200);
  expect(sqlBackupOwner.headers.get("content-type")).toContain("application/sql");
  await sqlBackupOwner.body?.cancel();

  const importDelegate = await ownerOps.canonicalPatientsImportPost(
    await fx.session("superDelegate"),
    jsonReq("http://localhost:3010/api/patients/import", "POST", {
      mode: "preview",
      fileName: "syn.csv",
      csv: "الاسم,الهاتف\nمريض تجريبي 39,777399999\n",
    }),
  );
  expect(importDelegate.status).toBe(403);

  const importOwner = await ownerOps.canonicalPatientsImportPost(
    await fx.session("owner"),
    jsonReq("http://localhost:3010/api/patients/import", "POST", {
      mode: "preview",
      fileName: "syn.csv",
      csv: "الاسم,الهاتف\nمريض تجريبي 39,777399999\n",
    }),
  );
  expect(importOwner.status).toBe(200);
  const importBody = await importOwner.json();
  expect(importBody.rows.length).toBe(1);
});

/** Slice 38: Canonical HR, Institutional Tasks & Internal/Outbound Messaging on real PostgreSQL 18. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import {
  openCanonicalInventoryDatabase,
  type CanonicalInventoryDatabase,
} from "./_canonical-inventory-fixture";

vi.mock("server-only", () => ({}));
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-slice38-hr-tasks-messages-20261101");

const db = await import("../../lib/db");
const canonHr = await import("../../lib/canonical-hr");
const canonMsgTasks = await import("../../lib/canonical-messages-tasks");
const { staffRuntimeActions } = await import("../../lib/staff-operation-runtime");

const ACCOUNTS = {
  owner: {
    username: "SYN-S38-OWNER",
    role: "admin",
    patientScope: "all",
    appointmentScope: "all",
    grants: {
      "messages.use": true,
      "tasks.use": true,
      "hr.directory.view": true,
      "hr.staff.manage": true,
      "hr.schedules.manage": true,
      "hr.attendance.record": true,
      "hr.attendance.correct": true,
      "hr.leaves.request": true,
      "hr.leaves.approve": true,
      "hr.payroll.manage": true,
      "hr.reports.view": true,
      "hr.settings.edit": true,
      "staff.view": true,
      "staff.profile.edit": true,
    },
  },
  hrCoordNoProfileEdit: {
    username: "SYN-S38-HR-COORD",
    role: "reception",
    patientScope: "all",
    grants: {
      "hr.directory.view": true,
      "hr.staff.manage": true,
      "hr.attendance.record": true,
      "hr.attendance.correct": true,
      "hr.payroll.manage": true,
      "tasks.use": true,
      "messages.use": true,
    },
  },
  ownDoctor: {
    username: "SYN-S38-DOC-OWN",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "messages.use": true,
      "tasks.use": true,
      "hr.leaves.request": true,
    },
  },
  otherDoctor: {
    username: "SYN-S38-DOC-OTHER",
    role: "doctor",
    doctor: true,
    patientScope: "own",
    appointmentScope: "own",
    grants: {
      "messages.use": true,
      "tasks.use": true,
      "hr.leaves.request": true,
    },
  },
  unprivileged: {
    username: "SYN-S38-NONE",
    role: "assistant",
    patientScope: "none",
    grants: {},
  },
} as const;

type Key = keyof typeof ACCOUNTS;

let fx: CanonicalInventoryDatabase<Key>;

const ids = {
  ownPatientId: 0,
  otherPatientId: 0,
  ownerStaffId: 0,
  doctorStaffId: 0,
  shiftId: 0,
};

function jsonReq(
  url: string,
  method: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Request {
  return new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...(extraHeaders ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");

  ids.ownPatientId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-S38-P1','SYN Own Patient','777380001',$1) RETURNING id",
      [fx.parties.ownDoctor!],
    )
  ).rows[0].id;

  ids.otherPatientId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-S38-P2','SYN Other Patient','777380002',$1) RETURNING id",
      [fx.parties.otherDoctor!],
    )
  ).rows[0].id;

  ids.shiftId = (
    await fx.pool.query<{ id: number }>(
      "INSERT INTO cashier_shifts(opened_by,opening_yer,opening_sar,opening_usd) VALUES('SYN-S38-OWNER',500000,0,0) RETURNING id",
    )
  ).rows[0].id;

  await fx.pool.query(
    `INSERT INTO settings(key,value) VALUES
       ('fx.USD_to_YER','530'),
       ('fx.SAR_to_YER','140')
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
  );

  await fx.pool.query(
    `INSERT INTO hr_leave_types (code, name_ar, is_paid, default_days_per_year, allow_negative, requires_attachment)
     VALUES
       ('annual', 'إجازة سنوية', true, NULL, false, false),
       ('sick', 'إجازة مرضية', true, NULL, false, true),
       ('unpaid', 'إجازة بدون راتب', false, NULL, true, false)
     ON CONFLICT (code) DO NOTHING`,
  );

  await fx.pool.query(
    `INSERT INTO hr_settings (key, value, description, effective_from, updated_by)
     VALUES
       ('payroll_cycle', '{"default_currency":"YER","salary_day":28,"cutoff_day":25}'::jsonb, 'دورة الرواتب الشهرية', CURRENT_DATE, 'system'),
       ('attendance_policy', '{"late_grace_mins":15,"late_deduction_rate_per_hour":1.0,"overtime_rate_multiplier":1.5}'::jsonb, 'سياسة الحضور', CURRENT_DATE, 'system'),
       ('leave_policy', '{"annual_default_days":21,"probation_months":3}'::jsonb, 'سياسة الإجازات', CURRENT_DATE, 'system')
     ON CONFLICT (key) DO NOTHING`,
  );
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

it("registers all 13 Slice 38 runtime actions", () => {
  const actions = new Set(staffRuntimeActions());
  for (const action of [
    "messages.use",
    "tasks.use",
    "hr.directory.view",
    "hr.staff.manage",
    "hr.schedules.manage",
    "hr.attendance.record",
    "hr.attendance.correct",
    "hr.leaves.request",
    "hr.leaves.approve",
    "hr.payroll.manage",
    "hr.reports.view",
    "hr.settings.edit",
    "staff.profile.edit",
  ] as const) {
    expect(actions.has(action)).toBe(true);
  }
});

it("enforces messages.use, patientScope isolation, and zero audit_log rows on AUDIT_EXEMPT internal messaging", async () => {
  const noneSession = await fx.session("unprivileged");
  const deniedRes = await canonMsgTasks.messagesGetCanonicalResponse(
    new Request("http://localhost/api/messages"),
    noneSession,
  );
  expect(deniedRes.status).toBe(403);

  const auditBefore = Number(
    (await fx.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM audit_log")).rows[0].n,
  );

  const ownDocSession = await fx.session("ownDoctor");
  const ownerSession = await fx.session("owner");

  // Internal direct message -> edit -> soft-delete writes ZERO audit_log rows
  const createdRes = await canonMsgTasks.messagesPostCanonicalResponse(
    jsonReq("http://localhost/api/messages", "POST", {
      to: { type: "user", id: fx.ids.owner },
      body: "SYN internal message",
    }),
    ownDocSession,
  );
  expect(createdRes.status).toBe(201);
  const createdMsg = (await createdRes.json()) as { id: number; body: string };
  expect(createdMsg.body).toBe("SYN internal message");

  const editedRes = await canonMsgTasks.messagesPatchCanonicalResponse(
    jsonReq("http://localhost/api/messages", "PATCH", {
      id: createdMsg.id,
      body: "SYN internal message edited",
    }),
    ownDocSession,
  );
  expect(editedRes.status).toBe(200);

  const deletedRes = await canonMsgTasks.messagesDeleteCanonicalResponse(
    new Request(`http://localhost/api/messages?id=${createdMsg.id}`, { method: "DELETE" }),
    ownDocSession,
  );
  expect(deletedRes.status).toBe(200);

  const auditAfterInternal = Number(
    (await fx.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM audit_log")).rows[0].n,
  );
  expect(auditAfterInternal).toBe(auditBefore);

  // Patient-linked message scope: ownDoctor can message ownPatientId, refused (403) on otherPatientId
  const ownPatientMsgRes = await canonMsgTasks.messagesPostCanonicalResponse(
    jsonReq("http://localhost/api/messages", "POST", {
      to: { type: "patient", id: ids.ownPatientId },
      body: "SYN care instruction",
    }),
    ownDocSession,
  );
  expect(ownPatientMsgRes.status).toBe(201);

  const otherPatientMsgRes = await canonMsgTasks.messagesPostCanonicalResponse(
    jsonReq("http://localhost/api/messages", "POST", {
      to: { type: "patient", id: ids.otherPatientId },
      body: "SYN unauthorized patient message",
    }),
    ownDocSession,
  );
  expect(otherPatientMsgRes.status).toBe(403);

  // Owner sends message to otherPatientId; ownDoctor thread read on otherPatientId returns 403
  const ownerOtherMsgRes = await canonMsgTasks.messagesPostCanonicalResponse(
    jsonReq("http://localhost/api/messages", "POST", {
      to: { type: "patient", id: ids.otherPatientId },
      body: "SYN owner reminder",
    }),
    ownerSession,
  );
  expect(ownerOtherMsgRes.status).toBe(201);

  const ownDocReadOtherThread = await canonMsgTasks.messagesGetCanonicalResponse(
    new Request(`http://localhost/api/messages?withPatient=${ids.otherPatientId}`),
    ownDocSession,
  );
  expect(ownDocReadOtherThread.status).toBe(403);

  // Outbound log patientScope isolation
  await fx.pool.query(
    `INSERT INTO message_deliveries(channel,direction,counterpart,body,status,patient_id,purpose,created_by)
     VALUES ('sms','out','777380001','SYN Own SMS','sent',$1,'manual','SYN-S38-OWNER'),
            ('sms','out','777380002','SYN Other SMS','sent',$2,'manual','SYN-S38-OWNER')`,
    [ids.ownPatientId, ids.otherPatientId],
  );
  const outboundOwnRes = await canonMsgTasks.messagesOutboundGetCanonicalResponse(
    new Request("http://localhost/api/messages/outbound"),
    ownDocSession,
  );
  expect(outboundOwnRes.status).toBe(200);
  const outboundOwnBody = (await outboundOwnRes.json()) as {
    rows: Array<{ patientId: number | null }>;
  };
  expect(outboundOwnBody.rows.map((r) => r.patientId)).toEqual([ids.ownPatientId]);

  const outboundDeniedOther = await canonMsgTasks.messagesOutboundGetCanonicalResponse(
    new Request(`http://localhost/api/messages/outbound?patientId=${ids.otherPatientId}`),
    ownDocSession,
  );
  expect(outboundDeniedOther.status).toBe(403);
});

it("manages HR staff, requires staff.profile.edit on user linking, records temporal history, and isolates /api/hr/me", async () => {
  const ownerSession = await fx.session("owner");
  const coordSession = await fx.session("hrCoordNoProfileEdit");
  const ownDocSession = await fx.session("ownDoctor");

  // Create HR staff files for owner & ownDoctor
  const createOwnerStaffRes = await canonHr.hrStaffPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/staff", "POST", {
      fullName: "SYN Owner Staff",
      jobTitle: "مدير المركز",
      department: "coordinator",
      hireDate: "2026-01-01",
      endDate: null,
      workStatus: "active",
      contractKind: "salary",
      salaryAmountMinor: 250_000,
      salaryCurrency: "YER",
      salaryPeriod: "monthly",
      salaryEffectiveOn: "2026-01-01",
      phone: null,
      note: null,
    }),
    ownerSession,
  );
  expect(createOwnerStaffRes.status).toBe(201);
  ids.ownerStaffId = ((await createOwnerStaffRes.json()) as { id: number }).id;

  const createDocStaffRes = await canonHr.hrStaffPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/staff", "POST", {
      fullName: "SYN Doctor Staff",
      jobTitle: "طبيب أسنان",
      department: "doctors",
      hireDate: "2026-01-01",
      endDate: null,
      workStatus: "active",
      contractKind: "salary",
      salaryAmountMinor: 300_000,
      salaryCurrency: "YER",
      salaryPeriod: "monthly",
      salaryEffectiveOn: "2026-01-01",
      phone: null,
      note: null,
    }),
    coordSession,
  );
  expect(createDocStaffRes.status).toBe(201);
  ids.doctorStaffId = ((await createDocStaffRes.json()) as { id: number }).id;

  // Coordinator has hr.staff.manage ONLY (no staff.profile.edit) -> link_user refused 403
  const coordLinkDenied = await canonHr.hrStaffDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/staff/${ids.doctorStaffId}`, "PATCH", {
      action: "link_user",
      userId: fx.ids.ownDoctor,
      reason: "محاولة ربط بدون staff.profile.edit",
    }),
    { params: Promise.resolve({ id: String(ids.doctorStaffId) }) },
    coordSession,
  );
  expect(coordLinkDenied.status).toBe(403);

  // Owner holds both hr.staff.manage and staff.profile.edit -> link_user succeeds
  const ownerLinkDoc = await canonHr.hrStaffDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/staff/${ids.doctorStaffId}`, "PATCH", {
      action: "link_user",
      userId: fx.ids.ownDoctor,
      reason: "ربط ملف الطبيب بحسابه",
    }),
    { params: Promise.resolve({ id: String(ids.doctorStaffId) }) },
    ownerSession,
  );
  expect(ownerLinkDoc.status).toBe(200);

  const ownerLinkSelf = await canonHr.hrStaffDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/staff/${ids.ownerStaffId}`, "PATCH", {
      action: "link_user",
      userId: fx.ids.owner,
      reason: "ربط ملف المدير بحسابه",
    }),
    { params: Promise.resolve({ id: String(ids.ownerStaffId) }) },
    ownerSession,
  );
  expect(ownerLinkSelf.status).toBe(200);

  // Record temporal employment & schedule history for doctorStaffId
  const empHistPost = await canonHr.hrStaffHistoryPostCanonicalResponse(
    jsonReq(`http://localhost/api/hr/staff/${ids.doctorStaffId}/history`, "POST", {
      requestId: "syn-s38-emp-hist-0001",
      expectedUsername: "SYN-S38-OWNER",
      expectedRevision: 0,
      reason: "توثيق مباشرة العمل المؤرخة",
      supersedeIds: [],
      append: [
        {
          id: "emp-fact-doc-1",
          kind: "known",
          from: "2026-01-01",
          to: null,
          value: { status: "active" },
        },
      ],
    }),
    { params: Promise.resolve({ id: String(ids.doctorStaffId) }) },
    "employment",
    ownerSession,
  );
  expect(empHistPost.status).toBe(200);

  const schedHistPost = await canonHr.hrStaffHistoryPostCanonicalResponse(
    jsonReq(`http://localhost/api/hr/staff/${ids.doctorStaffId}/schedule-history`, "POST", {
      requestId: "syn-s38-sch-hist-0001",
      expectedUsername: "SYN-S38-OWNER",
      expectedRevision: 0,
      reason: "توثيق جدول الدوام المؤرخ",
      supersedeIds: [],
      append: [
        {
          id: "sch-fact-doc-1",
          kind: "known",
          from: "2026-01-01",
          to: null,
          value: {
            timeZone: "Asia/Aden",
            workingDays: [0, 1, 2, 3, 4, 6],
            graceMins: 15,
            segments: [
              { id: "seg-1", start: "09:00", end: "17:00", startDayOffset: 0, endDayOffset: 0 },
            ],
          },
        },
      ],
    }),
    { params: Promise.resolve({ id: String(ids.doctorStaffId) }) },
    "schedule",
    ownerSession,
  );
  expect(schedHistPost.status).toBe(200);

  // Identity preview GET & POST (POST is AUDIT_EXEMPT -> zero audit rows added)
  const previewGetRes = await canonHr.hrIdentityPreviewGetCanonicalResponse(ownerSession);
  expect(previewGetRes.status).toBe(200);
  const previewBody = (await previewGetRes.json()) as { sourceDigest: string };
  expect(typeof previewBody.sourceDigest).toBe("string");

  const auditBeforePreview = Number(
    (await fx.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM audit_log")).rows[0].n,
  );
  const previewPostRes = await canonHr.hrIdentityPreviewPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/identity-preview", "POST", {
      sourceDigest: previewBody.sourceDigest,
      decisions: [],
    }),
    ownerSession,
  );
  expect(previewPostRes.status).toBe(200);
  const auditAfterPreview = Number(
    (await fx.pool.query<{ n: string }>("SELECT COUNT(*)::text AS n FROM audit_log")).rows[0].n,
  );
  expect(auditAfterPreview).toBe(auditBeforePreview);

  // Self-service /api/hr/me works with zero HR management capabilities and returns own staff profile only
  const docMeRes = await canonHr.hrMeGetCanonicalResponse(ownDocSession);
  expect(docMeRes.status).toBe(200);
  const docMeBody = (await docMeRes.json()) as {
    linked: boolean;
    staff: { id: number; fullName: string } | null;
  };
  expect(docMeBody.linked).toBe(true);
  expect(docMeBody.staff?.id).toBe(ids.doctorStaffId);
  expect(docMeBody.staff?.fullName).toBe("SYN Doctor Staff");
});

it("enforces task privacy, idempotent creation, patientScope link redaction, and atomic task audit rows", async () => {
  const ownerSession = await fx.session("owner");
  const ownDocSession = await fx.session("ownDoctor");
  const otherDocSession = await fx.session("otherDoctor");

  // Private task created by ownDoctor is invisible (404) even to clinic owner
  const privRes = await canonMsgTasks.tasksPostCanonicalResponse(
    jsonReq("http://localhost/api/tasks", "POST", {
      title: "SYN Private Doctor Note",
      isPrivate: true,
      clientRequestId: "syn-s38-priv-task-01",
    }),
    ownDocSession,
  );
  expect(privRes.status).toBe(201);
  const privTask = (await privRes.json()) as { id: number };

  const ownerPeekPrivate = await canonMsgTasks.taskDetailGetCanonicalResponse(
    String(privTask.id),
    ownerSession,
  );
  expect(ownerPeekPrivate.status).toBe(404);

  // Shared task assigned to doctorStaffId with idempotent replay
  const sharedPayload = {
    title: "SYN Follow up lab case",
    priority: "high",
    assigneeStaffId: ids.doctorStaffId,
    clientRequestId: "syn-s38-shared-task-01",
  };
  const sharedRes1 = await canonMsgTasks.tasksPostCanonicalResponse(
    jsonReq("http://localhost/api/tasks", "POST", sharedPayload),
    ownerSession,
  );
  expect(sharedRes1.status).toBe(201);
  const sharedTask1 = (await sharedRes1.json()) as { id: number };

  const sharedRes2 = await canonMsgTasks.tasksPostCanonicalResponse(
    jsonReq("http://localhost/api/tasks", "POST", sharedPayload),
    ownerSession,
  );
  expect(sharedRes2.status).toBe(201);
  const sharedTask2 = (await sharedRes2.json()) as { id: number };
  expect(sharedTask2.id).toBe(sharedTask1.id);

  // Assignee (ownDoctor) can add checklist item & comment, and cannot link outside-scope patient
  const checkRes = await canonMsgTasks.taskChecklistPostCanonicalResponse(
    jsonReq(`http://localhost/api/tasks/${sharedTask1.id}/checklist`, "POST", {
      op: "add",
      label: "Verify impression",
      clientRequestId: "syn-s38-check-0001",
    }),
    String(sharedTask1.id),
    ownDocSession,
  );
  expect(checkRes.status).toBe(200);

  const commentRes = await canonMsgTasks.taskCommentsPostCanonicalResponse(
    jsonReq(`http://localhost/api/tasks/${sharedTask1.id}/comments`, "POST", {
      body: "Ready for review",
      clientRequestId: "syn-s38-comment-0001",
    }),
    String(sharedTask1.id),
    ownDocSession,
  );
  expect(commentRes.status).toBe(201);

  // Owner links otherPatientId to sharedTask1; when ownDoctor reads task detail, label is redacted (readable: false)
  const linkOtherRes = await canonMsgTasks.taskLinksPostCanonicalResponse(
    jsonReq(`http://localhost/api/tasks/${sharedTask1.id}/links`, "POST", {
      linkKind: "patient",
      linkId: ids.otherPatientId,
    }),
    String(sharedTask1.id),
    ownerSession,
  );
  expect(linkOtherRes.status).toBe(201);

  const ownDocDetailRes = await canonMsgTasks.taskDetailGetCanonicalResponse(
    String(sharedTask1.id),
    ownDocSession,
  );
  expect(ownDocDetailRes.status).toBe(200);
  const ownDocDetail = (await ownDocDetailRes.json()) as {
    links: Array<{ id: number; linkId: number; label: string; readable: boolean }>;
  };
  expect(ownDocDetail.links).toHaveLength(1);
  expect(ownDocDetail.links[0].readable).toBe(false);
  expect(ownDocDetail.links[0].label).toBe("");

  // Unrelated otherDoctor cannot see sharedTask1 (not creator, not assignee, no hr.directory.view)
  const otherDocDetailRes = await canonMsgTasks.taskDetailGetCanonicalResponse(
    String(sharedTask1.id),
    otherDocSession,
  );
  expect(otherDocDetailRes.status).toBe(404);

  // Verify audit_log rows written for task mutations
  const taskAudits = await fx.pool.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE entity = 'hr_task' AND entity_id = $1",
    [String(sharedTask1.id)],
  );
  const actions = new Set(taskAudits.rows.map((r) => r.action));
  expect(actions.has("task.create")).toBe(true);
  expect(actions.has("task.checklist")).toBe(true);
  expect(actions.has("task.comment")).toBe(true);
  expect(actions.has("task.link")).toBe(true);
});

it("enforces dual-control vs sole-owner separation of duties on attendance/leaves and runs end-to-end payroll + disbursement + reversal", async () => {
  const ownerSession = await fx.session("owner");
  const coordSession = await fx.session("hrCoordNoProfileEdit");
  const ownDocSession = await fx.session("ownDoctor");

  // 1. Schedule + Contract creation & owner approval
  const schedRes = await canonHr.hrSchedulesPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/schedules", "POST", {
      staffId: ids.doctorStaffId,
      name: "دوام الطبيب الصباحي",
      scheduleType: "morning",
      effectiveFrom: "2026-01-01",
      workingDays: [0, 1, 2, 3, 4, 6],
      shiftStartTime: "09:00",
      shiftEndTime: "17:00",
      expectedDailyHours: 8,
    }),
    ownerSession,
  );
  expect(schedRes.status).toBe(201);

  const contractRes = await canonHr.hrContractsPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/contracts", "POST", {
      staffId: ids.doctorStaffId,
      templateKind: "doctor_salary",
      title: "عقد طبيب مقيم",
      startDate: "2026-01-01",
      compensationKind: "salary",
      baseSalaryMinor: 300_000,
      salaryCurrency: "YER",
      salaryPeriod: "monthly",
    }),
    coordSession,
  );
  expect(contractRes.status).toBe(201);
  const contract = (await contractRes.json()) as { id: number };

  const submitContract = await canonHr.hrContractDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/contracts/${contract.id}`, "PATCH", {
      action: "transition",
      status: "under_review",
      reason: "رفع للاعتماد",
    }),
    { params: Promise.resolve({ id: String(contract.id) }) },
    coordSession,
  );
  expect(submitContract.status).toBe(200);

  // Non-owner coordinator cannot approve a contract they created themselves -> 403
  const coordApproveDenied = await canonHr.hrContractDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/contracts/${contract.id}`, "PATCH", {
      action: "transition",
      status: "approved",
    }),
    { params: Promise.resolve({ id: String(contract.id) }) },
    coordSession,
  );
  expect(coordApproveDenied.status).toBe(403);

  const ownerApproveContract = await canonHr.hrContractDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/contracts/${contract.id}`, "PATCH", {
      action: "transition",
      status: "approved",
    }),
    { params: Promise.resolve({ id: String(contract.id) }) },
    ownerSession,
  );
  expect(ownerApproveContract.status).toBe(200);

  const activateContract = await canonHr.hrContractDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/contracts/${contract.id}`, "PATCH", {
      action: "transition",
      status: "active",
      reason: "بدء السريان",
    }),
    { params: Promise.resolve({ id: String(contract.id) }) },
    ownerSession,
  );
  expect(activateContract.status).toBe(200);

  // 2. Attendance punch & Dual-control correction:
  // BOTH owner and hrCoordNoProfileEdit hold hr.attendance.correct -> owner CANNOT self-approve own correction request!
  const punchRes = await canonHr.hrAttendancePostCanonicalResponse(
    jsonReq("http://localhost/api/hr/attendance", "POST", {
      staffId: ids.doctorStaffId,
      punchType: "check_in",
      punchTime: "2026-10-05T06:05:00.000Z",
      source: "manual",
    }),
    ownerSession,
  );
  expect(punchRes.status).toBe(201);
  const attRecord = (await punchRes.json()) as { id: number };

  const corrReqRes = await canonHr.hrAttendanceCorrectionsPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/attendance/corrections", "POST", {
      attendanceRecordId: attRecord.id,
      fieldCorrected: "check_out",
      newCheckOut: "2026-10-05T14:00:00.000Z",
      reason: "نسيان تسجيل بصمة الانصراف",
    }),
    ownerSession,
  );
  expect(corrReqRes.status).toBe(201);
  const corrReq = (await corrReqRes.json()) as { id: number };

  const ownerSelfApproveCorr = await canonHr.hrAttendanceCorrectionsPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/attendance/corrections", "POST", {
      action: "decide",
      id: corrReq.id,
      decision: "approved",
      reason: "محاولة اعتماد ذاتي بوجود مفوّض ثانٍ",
    }),
    ownerSession,
  );
  expect(ownerSelfApproveCorr.status).toBe(403);

  // Second holder (hrCoordNoProfileEdit) approves owner's correction request -> 200!
  const coordApproveCorr = await canonHr.hrAttendanceCorrectionsPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/attendance/corrections", "POST", {
      action: "decide",
      id: corrReq.id,
      decision: "approved",
      reason: "اعتماد المنسق المستقل",
    }),
    coordSession,
  );
  expect(coordApproveCorr.status).toBe(200);

  // 3. Leaves: ONLY owner holds hr.leaves.approve -> soleOwner=true allows owner to approve own leave request!
  const balRes = await canonHr.hrLeaveBalancesPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/leaves/balances", "POST", {
      staffId: ids.ownerStaffId,
      leaveTypeCode: "annual",
      year: 2026,
      allocatedDays: 21,
      reason: "رصيد سنوي افتتاحي",
    }),
    ownerSession,
  );
  expect(balRes.status).toBe(201);

  const ownerLeaveReqRes = await canonHr.hrLeavesPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/leaves", "POST", {
      staffId: ids.ownerStaffId,
      leaveTypeCode: "annual",
      startDate: "2026-10-12",
      endDate: "2026-10-13",
      reason: "إجازة سنوية",
    }),
    ownerSession,
  );
  expect(ownerLeaveReqRes.status).toBe(201);
  const ownerLeave = (await ownerLeaveReqRes.json()) as { id: number };

  // ownDoctor does not hold hr.leaves.approve -> 403
  const docApproveDenied = await canonHr.hrLeaveDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/leaves/${ownerLeave.id}`, "PATCH", {
      status: "approved",
    }),
    { params: Promise.resolve({ id: String(ownerLeave.id) }) },
    ownDocSession,
  );
  expect(docApproveDenied.status).toBe(403);

  // Sole owner of hr.leaves.approve approves -> 200
  const soleOwnerApproveLeave = await canonHr.hrLeaveDetailPatchCanonicalResponse(
    jsonReq(`http://localhost/api/hr/leaves/${ownerLeave.id}`, "PATCH", {
      status: "approved",
      decisionNotes: "اعتماد المالك المنفرد للصلاحية",
    }),
    { params: Promise.resolve({ id: String(ownerLeave.id) }) },
    ownerSession,
  );
  expect(soleOwnerApproveLeave.status).toBe(200);

  // 4. Payroll period -> calculate by coordinator -> approve by owner -> disburse -> idempotent reverse
  const periodRes = await canonHr.hrPayrollPeriodsPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/payroll/periods", "POST", {
      periodMonth: "2026-10",
      action: "open",
    }),
    ownerSession,
  );
  expect(periodRes.status).toBe(201);
  const period = (await periodRes.json()) as { id: number };

  const calcRes = await canonHr.hrPayrollRunsPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/payroll/runs", "POST", {
      action: "calculate",
      periodId: period.id,
      currency: "YER",
    }),
    coordSession,
  );
  expect(calcRes.status).toBe(201);
  const calcRun = (await calcRes.json()) as { id: number };

  const runDetailRes = await canonHr.hrPayrollRunsGetCanonicalResponse(
    new Request(`http://localhost/api/hr/payroll/runs?id=${calcRun.id}`),
    coordSession,
  );
  expect(runDetailRes.status).toBe(200);
  const run = (await runDetailRes.json()) as {
    id: number;
    items: Array<{ id: number; netDueMinor: number }>;
  };
  expect(run.items.length).toBeGreaterThan(0);

  const approveRunRes = await canonHr.hrPayrollRunsPostCanonicalResponse(
    jsonReq("http://localhost/api/hr/payroll/runs", "POST", {
      action: "approve",
      runId: run.id,
    }),
    ownerSession,
  );
  expect(approveRunRes.status).toBe(200);

  const targetItem = run.items.find((i) => i.netDueMinor > 0) ?? run.items[0];
  const disburseKey = "syn-s38-disburse-req-0001";
  const disburseRes = await canonHr.hrPayrollDisbursePostCanonicalResponse(
    jsonReq("http://localhost/api/hr/payroll/disburse", "POST", {
      itemId: targetItem.id,
      amountMinor: 50_000,
      paymentMethod: "cash",
      clientRequestId: disburseKey,
      notes: "دفعة راتب تجريبية",
    }),
    ownerSession,
  );
  expect(disburseRes.status).toBe(201);
  const disburseBody = (await disburseRes.json()) as {
    success: boolean;
    disbursement: { id: number; replayed?: boolean };
  };
  expect(disburseBody.success).toBe(true);

  // Replay with same clientRequestId returns 200 replayed
  const disburseReplay = await canonHr.hrPayrollDisbursePostCanonicalResponse(
    jsonReq("http://localhost/api/hr/payroll/disburse", "POST", {
      itemId: targetItem.id,
      amountMinor: 50_000,
      paymentMethod: "cash",
      clientRequestId: disburseKey,
      notes: "دفعة راتب تجريبية",
    }),
    ownerSession,
  );
  expect(disburseReplay.status).toBe(200);

  const lookupRes = await canonHr.hrPayrollDisburseGetCanonicalResponse(
    new Request(`http://localhost/api/hr/payroll/disburse?clientRequestId=${disburseKey}`),
    ownerSession,
  );
  expect(lookupRes.status).toBe(200);

  // Reverse disbursement with Idempotency-Key + replay verification
  const revHeaders = { "Idempotency-Key": "syn-s38-rev-idem-0001" };
  const revRes1 = await canonHr.hrPayrollDisbursePostCanonicalResponse(
    jsonReq(
      "http://localhost/api/hr/payroll/disburse",
      "POST",
      {
        action: "reverse",
        disbursementId: disburseBody.disbursement.id,
        reason: "تصحيح مبلغ تجريبي",
      },
      revHeaders,
    ),
    ownerSession,
  );
  expect(revRes1.status).toBe(200);

  const revRes2 = await canonHr.hrPayrollDisbursePostCanonicalResponse(
    jsonReq(
      "http://localhost/api/hr/payroll/disburse",
      "POST",
      {
        action: "reverse",
        disbursementId: disburseBody.disbursement.id,
        reason: "تصحيح مبلغ تجريبي",
      },
      revHeaders,
    ),
    ownerSession,
  );
  expect(revRes2.status).toBe(200);
  expect(revRes2.headers.get("X-Idempotent-Replay")).toBe("true");

  // HR Reports, Settings & History Preview reads
  const reportsRes = await canonHr.hrReportsGetCanonicalResponse(ownerSession);
  expect(reportsRes.status).toBe(200);

  const settingsPatchRes = await canonHr.hrSettingsPatchCanonicalResponse(
    jsonReq("http://localhost/api/hr/settings", "PATCH", {
      attendancePolicy: {
        lateGraceMins: 20,
        lateDeductionRatePerHour: 0,
        overtimeRateMultiplier: 1.5,
      },
    }),
    ownerSession,
  );
  expect(settingsPatchRes.status).toBe(200);

  const settingsHistoryRes = await canonHr.hrSettingsHistoryGetCanonicalResponse(
    new Request("http://localhost/api/hr/settings/history"),
    ownerSession,
  );
  expect(settingsHistoryRes.status).toBe(200);

  const payrollHistPreviewRes = await canonHr.hrPayrollHistoryPreviewGetCanonicalResponse(
    new Request(
      `http://localhost/api/hr/payroll/history-preview?staffId=${ids.doctorStaffId}&from=2026-10-01&to=2026-10-31`,
    ),
    ownerSession,
  );
  expect(payrollHistPreviewRes.status).toBe(200);
});

it("immediately revokes active canonical sessions (401) across HR reads, task writes, and self-service when permission revision advances", async () => {
  const staleDocSession = await fx.session("ownDoctor");
  await fx.setGrants(
    "ownDoctor",
    { "messages.use": true, "tasks.use": true, "hr.leaves.request": true },
    { patientScope: "own", appointmentScope: "own" },
  );

  const meRevoked = await canonHr.hrMeGetCanonicalResponse(staleDocSession);
  expect(meRevoked.status).toBe(401);

  const leavesRevoked = await canonHr.hrLeavesGetCanonicalResponse(
    new Request("http://localhost/api/hr/leaves"),
    staleDocSession,
  );
  expect(leavesRevoked.status).toBe(401);

  const taskWriteRevoked = await canonMsgTasks.tasksPostCanonicalResponse(
    jsonReq("http://localhost/api/tasks", "POST", {
      title: "SYN Revoked Task",
      isPrivate: true,
    }),
    staleDocSession,
  );
  expect(taskWriteRevoked.status).toBe(401);
});

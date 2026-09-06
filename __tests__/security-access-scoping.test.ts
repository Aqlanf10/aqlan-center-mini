import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  staff: vi.fn(),
  user: vi.fn(),
  owns: vi.fn(),
  cephStudy: vi.fn(),
  orthoCase: vi.fn(),
  clinicalVisit: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  requireSession: mocks.staff,
  requireSessionStrict: mocks.staff,
}));
vi.mock("@/lib/portal-server", () => ({
  requirePortalSession: vi.fn(async () => null),
}));
vi.mock("@/lib/db", () => ({
  findUserByUsername: mocks.user,
  doctorOwnsPatient: mocks.owns,
  getCephStudy: mocks.cephStudy,
  getOrthoCase: mocks.orthoCase,
  getClinicalVisit: mocks.clinicalVisit,
  getSettings: vi.fn(async () => ({ "finance.base_currency": "YER" })),
  listPatientPlans: vi.fn(async () => []),
  listPatientPlannedVisits: vi.fn(async () => []),
  patientChart: vi.fn(async () => ({ teeth: {} })),
  listPatientCephAnalyses: vi.fn(async () => []),
  getPool: vi.fn(() => ({ query: mocks.poolQuery })),
  ensureSchema: vi.fn(async () => {}),
  createOrthoCase: vi.fn(async () => ({ ok: true, id: 10 })),
  createCephAnalysis: vi.fn(async () => ({ ok: true, id: 20 })),
  recordAdjustment: vi.fn(async () => ({ ok: true, id: 30 })),
  completeCephAnalysis: vi.fn(async () => ({ ok: true, measurements: [], summary: "ok" })),
  duplicateCephAnalysis: vi.fn(async () => ({ ok: true, id: 21 })),
  discardCephAnalysis: vi.fn(async () => ({ ok: true })),
  updateCephCalibration: vi.fn(async () => ({ ok: true })),
  updateCephLandmarks: vi.fn(async () => ({ ok: true })),
  updateCephDiagnosis: vi.fn(async () => ({ ok: true })),
  listBookingRequests: vi.fn(async () => []),
  rejectBookingRequest: vi.fn(async () => ({ id: 1 })),
  listPatientDiagnoses: vi.fn(async () => []),
  recordPatientDiagnosis: vi.fn(async () => ({ id: 1, version: 1 })),
  recordAudit: vi.fn(async () => {}),
  patientThreadMessages: vi.fn(async () => []),
  markConversationRead: vi.fn(async () => {}),
  getPatient: vi.fn(async (id: number) => ({ id, fullName: "Test Patient" })),
  insertMessage: vi.fn(async () => ({ id: 1 })),
  fileMessagePayload: vi.fn(async () => ({
    senderType: "patient",
    recipientPatientId: 99,
    data: "dGVzdA==",
    mime: "application/pdf",
    name: "test.pdf",
  })),
  markAppointmentFollowedUp: vi.fn(async () => true),
  updateLabOrderAccounting: vi.fn(async () => ({ id: 1 })),
  createInventoryMovement: vi.fn(async () => ({ ok: true, movement: { id: 1 }, balance: 10 })),
  patientLedger: vi.fn(async () => ({ invoices: [], payments: [], opening: 0 })),
  CLINIC_TIME_ZONE: "Asia/Aden",
}));

import { GET as cephGet, PATCH as cephPatch, DELETE as cephDelete } from "../app/api/ceph/[id]/route";
import { POST as cephComplete } from "../app/api/ceph/[id]/complete/route";
import { POST as cephDuplicate } from "../app/api/ceph/[id]/duplicate/route";
import { POST as cephAiAnalyze } from "../app/api/ceph/[id]/ai-analyze/route";
import { GET as orthoGet, POST as orthoPost, PATCH as orthoPatch } from "../app/api/ortho/[id]/route";
import { POST as orthoCreate } from "../app/api/ortho/route";
import { GET as materialsGet } from "../app/api/patients/[id]/materials/route";
import { GET as chartGet, POST as chartPost } from "../app/api/patients/[id]/chart/route";
import { GET as cephPatientGet, POST as cephPatientPost } from "../app/api/patients/[id]/ceph/route";
import { GET as plansGet } from "../app/api/patients/[id]/plans/route";
import { GET as bookingGet } from "../app/api/booking-requests/route";
import { PATCH as bookingPatch } from "../app/api/booking-requests/[id]/route";
import { POST as visitNextPost } from "../app/api/visits/[id]/next/route";
import { GET as diagnosesGet, POST as diagnosesPost } from "../app/api/patients/[id]/diagnoses/route";
import { POST as plannedSchedulePost } from "../app/api/planned-visits/[id]/schedule/route";
import { GET as messagesGet, POST as messagesPost } from "../app/api/messages/route";
import { GET as messageFileGet } from "../app/api/messages/file/[id]/route";
import { POST as recallPost } from "../app/api/recall/route";
import { PATCH as labPatch } from "../app/api/lab/[id]/route";
import { POST as inventoryMovementsPost } from "../app/api/inventory/[id]/movements/route";
import { GET as ledgerGet } from "../app/api/patients/[id]/ledger/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.poolQuery.mockResolvedValue({ rows: [{ patient_id: 99 }] });
  mocks.staff.mockResolvedValue({ userId: 7, username: "doctor_user", role: "doctor", partyId: 7 });
  mocks.user.mockResolvedValue({
    id: 7,
    isActive: true,
    partyId: 7,
    permissions: { canViewXrays: true, canUploadXrays: true },
  });
  mocks.owns.mockResolvedValue(false);
  mocks.cephStudy.mockResolvedValue({
    analysis: { id: 101, patientId: 99, status: "draft" },
    landmarks: [],
  });
  mocks.orthoCase.mockResolvedValue({
    id: 202,
    patientId: 99,
    status: "active",
  });
  mocks.clinicalVisit.mockResolvedValue({
    id: 303,
    patientId: 99,
  });
});

describe("حماية عزل المرضى ومكافحة ثغرات IDOR في السيفالو والتقويم والمواد", () => {
  describe("وحدة السيفالومتري (Ceph Security)", () => {
    it("يحجب قراءة دراسة سيفالو تخص مريض طبيب آخر", async () => {
      const res = await cephGet(new Request("http://localhost/api/ceph/101"), {
        params: Promise.resolve({ id: "101" }),
      });
      expect(res.status).toBe(403);
    });

    it("يسمح بقراءة دراسة سيفالو عند ثبوت ملكية الطبيب للمريض", async () => {
      mocks.owns.mockResolvedValue(true);
      const res = await cephGet(new Request("http://localhost/api/ceph/101"), {
        params: Promise.resolve({ id: "101" }),
      });
      expect(res.status).toBe(200);
    });

    it("يحجب تعديل أو حذف أو اعتماد أو نسخ دراسة سيفالو تخص مريض طبيب آخر", async () => {
      const ctx = { params: Promise.resolve({ id: "101" }) };
      const patchRes = await cephPatch(
        new Request("http://localhost/api/ceph/101", {
          method: "PATCH",
          body: JSON.stringify({ diagnosis: { finalDx: "Class II" } }),
          headers: { "Content-Type": "application/json" },
        }),
        ctx,
      );
      expect(patchRes.status).toBe(403);

      const deleteRes = await cephDelete(new Request("http://localhost/api/ceph/101", { method: "DELETE" }), ctx);
      expect(deleteRes.status).toBe(403);

      const completeRes = await cephComplete(new Request("http://localhost/api/ceph/101/complete", { method: "POST" }), ctx);
      expect(completeRes.status).toBe(403);

      const duplicateRes = await cephDuplicate(new Request("http://localhost/api/ceph/101/duplicate", { method: "POST" }), ctx);
      expect(duplicateRes.status).toBe(403);

      const aiRes = await cephAiAnalyze(
        new Request("http://localhost/api/ceph/101/ai-analyze", {
          method: "POST",
          body: JSON.stringify({ action: "suggest-landmarks" }),
          headers: { "Content-Type": "application/json" },
        }),
        ctx,
      );
      expect(aiRes.status).toBe(403);
    });
  });

  describe("وحدة التقويم (Ortho Security)", () => {
    it("يحجب قراءة أو تعديل أو تسجيل شدات لحالة تقويم تخص مريض طبيب آخر", async () => {
      const ctx = { params: Promise.resolve({ id: "202" }) };

      const getRes = await orthoGet(new Request("http://localhost/api/ortho/202"), ctx);
      expect(getRes.status).toBe(403);

      const postRes = await orthoPost(
        new Request("http://localhost/api/ortho/202", {
          method: "POST",
          body: JSON.stringify({ done: "Wire change" }),
          headers: { "Content-Type": "application/json" },
        }),
        ctx,
      );
      expect(postRes.status).toBe(403);

      const patchRes = await orthoPatch(
        new Request("http://localhost/api/ortho/202", {
          method: "PATCH",
          body: JSON.stringify({ phase: "leveling" }),
          headers: { "Content-Type": "application/json" },
        }),
        ctx,
      );
      expect(patchRes.status).toBe(403);
    });

    it("يحجب إنشاء حالة تقويم لمريض لا يملكه الطبيب", async () => {
      const res = await orthoCreate(
        new Request("http://localhost/api/ortho", {
          method: "POST",
          body: JSON.stringify({ patientId: 99, appliance: "fixed_metal" }),
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(res.status).toBe(403);
    });
  });

  describe("السجلات السريرية لملف المريض (Patient Clinical Data)", () => {
    it("يحجب قراءة المواد والمستهلكات لمريض لا يملكه الطبيب", async () => {
      const res = await materialsGet(new Request("http://localhost/api/patients/99/materials"), {
        params: Promise.resolve({ id: "99" }),
      });
      expect(res.status).toBe(403);
    });

    it("يحجب قراءة وتعديل مخطط الأسنان لمريض لا يملكه الطبيب", async () => {
      const ctx = { params: Promise.resolve({ id: "99" }) };
      const getRes = await chartGet(new Request("http://localhost/api/patients/99/chart"), ctx);
      expect(getRes.status).toBe(403);

      const postRes = await chartPost(
        new Request("http://localhost/api/patients/99/chart", {
          method: "POST",
          body: JSON.stringify({ toothCode: 11, condition: "caries" }),
          headers: { "Content-Type": "application/json" },
        }),
        ctx,
      );
      expect(postRes.status).toBe(403);
    });

    it("يحجب قراءة دراسات السيفالو وفتح دراسة جديدة لمريض طبيب آخر", async () => {
      const ctx = { params: Promise.resolve({ id: "99" }) };
      const getRes = await cephPatientGet(new Request("http://localhost/api/patients/99/ceph"), ctx);
      expect(getRes.status).toBe(403);

      const postRes = await cephPatientPost(
        new Request("http://localhost/api/patients/99/ceph", {
          method: "POST",
          body: JSON.stringify({ documentId: 5 }),
          headers: { "Content-Type": "application/json" },
        }),
        ctx,
      );
      expect(postRes.status).toBe(403);
    });

    it("يحجب قراءة خطط العلاج لمريض لا يملكه الطبيب", async () => {
      const res = await plansGet(new Request("http://localhost/api/patients/99/plans"), {
        params: Promise.resolve({ id: "99" }),
      });
      expect(res.status).toBe(403);
    });

    it("يحجب جدولة الجلسة التالية لمريض ليس من مرضى الطبيب", async () => {
      const res = await visitNextPost(
        new Request("http://localhost/api/visits/303/next", {
          method: "POST",
          body: JSON.stringify({ date: "2026-09-10", time: "10:00" }),
          headers: { "Content-Type": "application/json" },
        }),
        { params: Promise.resolve({ id: "303" }) },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("صلاحيات طلبات الحجز أونلاين (Booking Requests RBAC)", () => {
    it("يحجب الطبيب من عرض أو اعتماد/رفض طلبات الحجز أونلاين", async () => {
      const getRes = await bookingGet(new Request("http://localhost/api/booking-requests"));
      expect(getRes.status).toBe(403);

      const patchRes = await bookingPatch(
        new Request("http://localhost/api/booking-requests/1", {
          method: "PATCH",
          body: JSON.stringify({ action: "reject" }),
          headers: { "Content-Type": "application/json" },
        }),
        { params: Promise.resolve({ id: "1" }) },
      );
      expect(patchRes.status).toBe(403);
    });

    it("يسمح للاستقبال بعرض وإدارة طلبات الحجز", async () => {
      mocks.staff.mockResolvedValue({ userId: 3, username: "receptionist", role: "reception" });
      const getRes = await bookingGet(new Request("http://localhost/api/booking-requests"));
      expect(getRes.status).toBe(200);
    });
  });

  describe("التشخيصات والزيارات المخططة (Diagnoses & Planned Visits)", () => {
    it("يحجب قراءة وإضافة تشخيص لمريض طبيب آخر", async () => {
      const ctx = { params: Promise.resolve({ id: "99" }) };
      const getRes = await diagnosesGet(new Request("http://localhost/api/patients/99/diagnoses"), ctx);
      expect(getRes.status).toBe(403);

      const postRes = await diagnosesPost(
        new Request("http://localhost/api/patients/99/diagnoses", {
          method: "POST",
          body: JSON.stringify({ content: { notes: "Carie" } }),
          headers: { "Content-Type": "application/json" },
        }),
        ctx,
      );
      expect(postRes.status).toBe(403);
    });

    it("يحجب تحويل زيارة مخططة لموعد لمريض طبيب آخر", async () => {
      const res = await plannedSchedulePost(
        new Request("http://localhost/api/planned-visits/1/schedule", {
          method: "POST",
          body: JSON.stringify({ date: "2026-09-10", time: "10:00" }),
          headers: { "Content-Type": "application/json" },
        }),
        { params: Promise.resolve({ id: "1" }) },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("المراسلات الداخلية ومرفقات المرضى (Messages & Attachments)", () => {
    it("يحجب قراءة محادثات أو مراسلة مريض طبيب آخر", async () => {
      const getRes = await messagesGet(new Request("http://localhost/api/messages?withPatient=99"));
      expect(getRes.status).toBe(403);

      const postRes = await messagesPost(
        new Request("http://localhost/api/messages", {
          method: "POST",
          body: JSON.stringify({ to: { type: "patient", id: 99 }, body: "مرحبًا" }),
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(postRes.status).toBe(403);
    });

    it("يحجب تنزيل مرفق خيط مريض لطبيب آخر", async () => {
      const res = await messageFileGet(
        new Request("http://localhost/api/messages/file/1"),
        { params: Promise.resolve({ id: "1" }) },
      );
      expect(res.status).toBe(403);
    });
  });

  describe("المتابعة والمختبرات والمخزون وحساب المريض (Recall, Lab, Inventory, Ledger)", () => {
    it("يحجب الطبيب من تسجيل متابعة recall", async () => {
      const res = await recallPost(
        new Request("http://localhost/api/recall", {
          method: "POST",
          body: JSON.stringify({ kind: "missed", id: 1 }),
          headers: { "Content-Type": "application/json" },
        }),
      );
      expect(res.status).toBe(403);
    });

    it("يحجب الطبيب من تعديل الربط المحاسبي والترحيل في أمر المختبر", async () => {
      const res = await labPatch(
        new Request("http://localhost/api/lab/1", {
          method: "PATCH",
          body: JSON.stringify({ action: "update_accounting", isPosted: true }),
          headers: { "Content-Type": "application/json" },
        }),
        { params: Promise.resolve({ id: "1" }) },
      );
      expect(res.status).toBe(403);
    });

    it("يحجب ربط حركة مخزون بمريض لا يملكه الطبيب", async () => {
      const res = await inventoryMovementsPost(
        new Request("http://localhost/api/inventory/1/movements", {
          method: "POST",
          body: JSON.stringify({ kind: "out", qty: 1, patientId: 99 }),
          headers: { "Content-Type": "application/json" },
        }),
        { params: Promise.resolve({ id: "1" }) },
      );
      expect(res.status).toBe(403);
    });

    it("يحجب قراءة كشف حساب مريض ليس من مرضى الطبيب", async () => {
      const res = await ledgerGet(
        new Request("http://localhost/api/patients/99/ledger"),
        { params: Promise.resolve({ id: "99" }) },
      );
      expect(res.status).toBe(403);
    });
  });
});

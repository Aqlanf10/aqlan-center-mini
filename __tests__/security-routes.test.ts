import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  portal: vi.fn(), staff: vi.fn(), user: vi.fn(), owns: vi.fn(), patient: vi.fn(),
  document: vi.fn(), bytes: vi.fn(), visits: vi.fn(), limit: vi.fn(), clinical: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  findUserByUsername: mocks.user, doctorOwnsPatient: mocks.owns,
  getPatient: mocks.patient, getDocumentForDownload: mocks.document,
  listTodayVisits: mocks.visits, getSettings: vi.fn(async () => ({})),
  consumeStaffLoginAttempt: mocks.limit,
  getClinicalVisit: mocks.clinical,
}));
vi.mock("@/lib/portal-server", () => ({ requirePortalSession: mocks.portal }));
vi.mock("@/lib/session", () => ({ requireSession: mocks.staff }));
vi.mock("@/lib/files", () => ({ readFileByKey: mocks.bytes }));
import { GET as checkinGet, POST as checkinPost } from "../app/api/checkin/route";
import { GET as documentGet } from "../app/api/documents/[id]/route";
import { POST as login } from "../app/api/auth/login/route";
import { canAccessPatient } from "../lib/patient-access";
import { GET as clinicalGet, POST as clinicalPost } from "../app/api/visits/[id]/clinical/route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.portal.mockResolvedValue(null);
  mocks.staff.mockResolvedValue({ userId: 7, username: "doctor", role: "doctor", partyId: 7 });
  mocks.user.mockResolvedValue({ id: 7, isActive: true, partyId: 7, permissions: { canViewXrays: true } });
  mocks.owns.mockResolvedValue(false);
  mocks.visits.mockResolvedValue([]);
  mocks.document.mockResolvedValue({ document: { patientId: 42, removedAt: null, title: "synthetic", mimeType: "image/png" }, storageKey: "test" });
  mocks.bytes.mockResolvedValue(Buffer.from("synthetic"));
  mocks.clinical.mockResolvedValue({ id: 1, patientId: 42 });
});

describe("حدود بيانات المرضى", () => {
  it("يفرض الملكية على قراءة الزيارة وكل عمليات كتابتها", async () => {
    const context = { params: Promise.resolve({ id: '1' }) };
    expect((await clinicalGet(new Request('http://localhost/api/visits/1/clinical'), context)).status).toBe(403);
    for (const action of ['save', 'sign', 'addendum']) {
      expect((await clinicalPost(new Request('http://localhost/api/visits/1/clinical', {
        method: 'POST', body: JSON.stringify({action}), headers: {'Content-Type':'application/json'}
      }), context)).status).toBe(403);
    }
  });
  it("يسمح بقراءة الزيارة للطبيب المصرح له بجميع المرضى", async () => {
    mocks.user.mockResolvedValue({ id: 7, isActive: true, permissions: { canViewAllPatients: true } });
    expect((await clinicalGet(new Request('http://localhost/api/visits/1/clinical'), {params:Promise.resolve({id:'1'})})).status).toBe(200);
  });
  it("يرفض البحث العام بالهاتف ومتابعة التذكرة دون جلسة قبل قراءة البيانات", async () => {
    for (const query of ["phone=770000000", "visitId=42"]) {
      expect((await checkinGet(new Request(`http://localhost/api/checkin?${query}`))).status).toBe(401);
    }
    expect(mocks.visits).not.toHaveBeenCalled();
    expect(mocks.patient).not.toHaveBeenCalled();
  });
  it("يرفض كتابة الحضور غير الموثق قبل قراءة جسم الطلب", async () => {
    expect((await checkinPost(new Request("http://localhost/api/checkin", { method: "POST" }))).status).toBe(401);
    expect(mocks.patient).not.toHaveBeenCalled();
  });
  it("الهاتف المرسل لا يبدل هوية المريض في الجلسة", async () => {
    mocks.portal.mockResolvedValue({ patientId: 42 });
    mocks.patient.mockResolvedValue({ id: 42, fullName: "Synthetic Patient", patientNumber: "P42" });
    const response = await checkinGet(new Request("http://localhost/api/checkin?phone=another-person"));
    expect(response.status).toBe(200);
    expect(mocks.patient).toHaveBeenCalledWith(42);
  });
  it("يرفض تنزيل مستند مريض آخر قبل قراءة الملف", async () => {
    expect((await documentGet(new Request("http://localhost/api/documents/1"), { params: Promise.resolve({ id: "1" }) })).status).toBe(403);
    expect(mocks.bytes).not.toHaveBeenCalled();
  });
  it("يعرض المستند للمالك المصرح له فقط", async () => {
    mocks.owns.mockResolvedValue(true);
    expect((await documentGet(new Request("http://localhost/api/documents/1"), { params: Promise.resolve({ id: "1" }) })).status).toBe(200);
    mocks.user.mockResolvedValue({ isActive: true, partyId: 7, permissions: { canViewXrays: false, canViewAllPatients: true } });
    expect((await documentGet(new Request("http://localhost/api/documents/1"), { params: Promise.resolve({ id: "1" }) })).status).toBe(403);
  });
  it("الطبيب غير المرتبط وفشل قراءة الصلاحيات لا يفتحان ملفًا", async () => {
    const session = await mocks.staff();
    mocks.user.mockResolvedValue({ isActive: true, partyId: null, permissions: {} });
    expect(await canAccessPatient(session, 42)).toBe(false);
    mocks.user.mockRejectedValue(new Error("offline"));
    expect(await canAccessPatient(session, 42)).toBe(false);
  });
  it("يحجب المالية افتراضيًا ولو كان الطبيب يملك المريض", async () => {
    mocks.owns.mockResolvedValue(true);
    expect(await canAccessPatient(await mocks.staff(), 42, "canViewPatientPayments")).toBe(false);
  });
  it("يمنع الدخول عند تجاوز الحد قبل استعلام المستخدم والتجزئة", async () => {
    mocks.limit.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });
    const response = await login(new Request("http://localhost/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "doctor", password: "synthetic" }),
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("900");
    expect(mocks.user).not.toHaveBeenCalled();
  });
});

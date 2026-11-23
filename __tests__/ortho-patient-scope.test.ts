import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDoctorPermissions } from "@/lib/doctor-permissions";
import type { Role } from "@/lib/roles";
import type { OrthoCase, PatientDocument } from "@/lib/db";

vi.mock("@/lib/session", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/db", () => ({
  CLINIC_TIME_ZONE: "Asia/Aden", listOrthoCases: vi.fn(), listPatientOrthoCases: vi.fn(),
  getOrthoCase: vi.fn(), findUserByUsername: vi.fn(), doctorOwnsPatient: vi.fn(), patientHasVisitToday: vi.fn(),
  getDocumentForDownload: vi.fn(),
}));
vi.mock("@/lib/files", () => ({ readFileByKey: vi.fn() }));
import { GET as list } from "@/app/api/ortho/route";
import { GET as detail } from "@/app/api/ortho/[id]/route";
import { GET as download } from "@/app/api/documents/[id]/route";
import { proxy } from "@/proxy";
import { requireSession } from "@/lib/session";
import {
  listOrthoCases, listPatientOrthoCases, getOrthoCase, findUserByUsername,
  doctorOwnsPatient, patientHasVisitToday, getDocumentForDownload,
} from "@/lib/db";
import { readFileByKey } from "@/lib/files";

const session = vi.mocked(requireSession);
const globalCases = vi.mocked(listOrthoCases);
const patientCases = vi.mocked(listPatientOrthoCases);
const caseById = vi.mocked(getOrthoCase);
const userByName = vi.mocked(findUserByUsername);
const owns = vi.mocked(doctorOwnsPatient);
const secret = "synthetic-ortho-patient-scope-not-a-live-credential";
const syntheticPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nAAAAABJRU5ErkJggg==", "base64");
function syntheticPhoto(caseId: number, patientId: number): PatientDocument {
  return {
    id: 965000 + caseId, patientId, kind: "photo", title: `Synthetic private image ${patientId}`,
    note: "Synthetic private image note", visitId: null, mimeType: "image/png", sizeBytes: syntheticPng.length,
    isImage: true, takenOn: "2026-10-01", uploadedBy: "synthetic-photo-uploader", uploadedAt: "2026-10-01T10:00:00Z",
    removedAt: null, removedBy: null, removedNote: null, orthoCaseId: caseId, adjustmentId: caseId + 1000,
    photoStage: "synthetic-photo-stage", photoView: "synthetic-photo-view", width: 1, height: 1,
  };
}
function fixture(id: number, patientId: number): OrthoCase {
  return {
    id, patientId, patientName: `Synthetic patient ${patientId}`, appliance: "fixed_metal", arches: "both", slot: "022",
    bracketSystem: null, status: "active", phase: "aligning", startDate: "2026-10-01", plannedMonths: 18,
    upperWire: "014 NiTi", lowerWire: "014 NiTi", planId: null, retainer: null, retainerOn: null,
    note: `Synthetic clinical note ${id}`, closedAt: null, closedBy: null, closedNote: null,
    baselineKind: null, baselineRecordedAt: null, elastics: null, responsibleDoctorId: 8,
    responsibleDoctorName: "Synthetic other case doctor", legacyFinancialMode: null, remainingObjectives: null,
    adjustments: [{
      id: id + 1000, visitId: null, visitSigned: false, doneOn: "2026-10-01", phase: "aligning",
      upperWire: "014 NiTi", lowerWire: "014 NiTi", elastics: "none", elasticNote: null,
      done: `Synthetic procedure ${id}`, nextWeeks: 4, note: "Synthetic adjustment note", recordedBy: "synthetic",
      photos: [syntheticPhoto(id, patientId)],
    }],
    progress: { monthsElapsed: 0, monthsPlanned: 18, monthsRemaining: 18, percent: 0, overdue: false,
      adjustments: 1, lastAdjustment: "2026-10-01", daysSinceLast: 0 },
  };
}
const cases = [fixture(11, 101), fixture(22, 202), fixture(33, 101)];
const context = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
function user(raw: unknown = {}) {
  return { id: 7, username: "synthetic", role: "doctor", isActive: true, partyId: 7,
    permissions: parseDoctorPermissions(raw, "doctor") } as NonNullable<Awaited<ReturnType<typeof findUserByUsername>>>;
}
function request(role: Role | null = "doctor", suffix = "", raw: unknown = {}, path = "/api/ortho") {
  const payload = { username: "synthetic", userId: 7, role: role!, expiresAt: Date.now() + 60_000, partyId: 7 };
  session.mockResolvedValue(role ? payload : null);
  userByName.mockResolvedValue(user(raw));
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const token = `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
  return new NextRequest(`https://synthetic.invalid${path}${suffix}`, {
    headers: role ? { authorization: `Bearer ${token}` } : {},
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("SESSION_SECRET", secret);
  globalCases.mockResolvedValue(cases);
  patientCases.mockImplementation(async (id) => cases.filter((row) => row.patientId === id));
  caseById.mockImplementation(async (id) => cases.find((row) => row.id === id) ?? null);
  owns.mockImplementation(async (_party, id) => id === 101);
});
afterEach(() => vi.unstubAllEnvs());

describe("actual ortho route, proxy and canonical patient guard", () => {
  it("requires a session before querying cases", async () => {
    const req = request(null);
    expect((await proxy(req)).status).toBe(401);
    expect((await list(req)).status).toBe(401);
    expect((await detail(req, context(11))).status).toBe(401);
    expect(globalCases).not.toHaveBeenCalled(); expect(caseById).not.toHaveBeenCalled();
  });

  it("contains a doctor admitted by the proxy to owned patients, retaining clinical order and photos", async () => {
    const req = request();
    expect((await proxy(req)).headers.get("x-middleware-next")).toBe("1");
    const response = await list(req);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.cases).toEqual([cases[0], cases[2]].map((row) => ({ ...row, photosVisible: true })));
    expect(JSON.stringify(body)).not.toContain("Synthetic patient 202");
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Two distinct patients: once for clinical access, then images only for the allowed patient.
    expect(owns.mock.calls.filter(([, id]) => id === 101)).toHaveLength(2);
    expect(owns.mock.calls.filter(([, id]) => id === 202)).toHaveLength(1);
    // Case doctor differs: access is based on the existing patient guard, never a new case-doctor rule.
    expect(body.cases[0].responsibleDoctorId).toBe(8);
  });

  it.each(["", "abc", "0", "-1", "1.5", "NaN", "Infinity", "1e2", "0x65", " 101", "101 ", "9007199254740992"])(
    "rejects supplied malformed patientId %j rather than broadening", async (value) => {
      const response = await list(request("doctor", `?patientId=${encodeURIComponent(value)}`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ message: "رقم المريض غير صالح." });
      expect(globalCases).not.toHaveBeenCalled(); expect(patientCases).not.toHaveBeenCalled();
    },
  );
  it("rejects duplicate filters including valid-first/invalid-last ambiguity", async () => {
    expect((await list(request("doctor", "?patientId=101&patientId=abc"))).status).toBe(400);
    expect(globalCases).not.toHaveBeenCalled(); expect(patientCases).not.toHaveBeenCalled();
  });

  it("retains explicit foreign patient/case denials and allowed patient filtering", async () => {
    const req = request("doctor", "?patientId=202");
    expect((await list(req)).status).toBe(403);
    expect(patientCases).not.toHaveBeenCalled(); expect(globalCases).not.toHaveBeenCalled();
    expect((await detail(req, context(22))).status).toBe(403);
    const response = await list(request("doctor", "?patientId=101"));
    expect((await response.json()).cases.map((row: OrthoCase) => row.id)).toEqual([11, 33]);
    expect(patientCases).toHaveBeenCalledWith(101, expect.any(String));
  });

  it("keeps full clinical photos for admin without a doctor lookup", async () => {
    const req = request("admin");
    const middleware = await proxy(req);
    expect(middleware.headers.get("x-middleware-next")).toBe("1");
    expect(middleware.headers.get("cache-control")).toBe("private, no-store");
    expect((await (await list(req)).json()).cases).toEqual(cases.map((row) => ({ ...row, photosVisible: true })));
    expect(await (await detail(req, context(22))).json()).toEqual({ ...cases[1], photosVisible: true });
    expect(userByName).not.toHaveBeenCalled(); expect(owns).not.toHaveBeenCalled();
  });

  it("keeps reception case context but no photo document on global, patient-filtered or detail GET", async () => {
    const withoutPhotos = (row: OrthoCase) => ({
      ...row, photosVisible: false, adjustments: row.adjustments.map((entry) => ({ ...entry, photos: [] })),
    });
    // Switch roles across requests against the same immutable hydrated rows.
    expect((await (await list(request("admin"))).json()).cases[0].adjustments[0].photos).toHaveLength(1);
    const global = request("reception");
    const filtered = request("reception", "?patientId=101");
    const direct = request("reception", "", {}, "/api/ortho/22");
    for (const req of [global, filtered, direct]) {
      const middleware = await proxy(req);
      expect(middleware.headers.get("x-middleware-next")).toBe("1");
      expect(middleware.headers.get("cache-control")).toBe("private, no-store");
    }
    const responses = [await list(global), await list(filtered), await detail(direct, context(22))];
    for (const response of responses) expect(response.status).toBe(200);
    const [all, scoped, single] = await Promise.all(responses.map((response) => response.json()));
    expect(all.cases).toStrictEqual(cases.map(withoutPhotos));
    expect(scoped.cases).toStrictEqual([cases[0], cases[2]].map(withoutPhotos));
    expect(single).toStrictEqual(withoutPhotos(cases[1]));
    const serialized = JSON.stringify([all, scoped, single]);
    for (const { adjustments } of cases) for (const { photos } of adjustments) for (const photo of photos) {
      for (const privateValue of [photo.id, photo.title, photo.note, photo.photoStage, photo.photoView, photo.uploadedBy, photo.mimeType]) {
        expect(serialized).not.toContain(String(privateValue));
      }
    }
    expect(getDocumentForDownload).not.toHaveBeenCalled(); expect(readFileByKey).not.toHaveBeenCalled();
    expect(userByName).not.toHaveBeenCalled(); expect(owns).not.toHaveBeenCalled();
    expect((await (await detail(request("doctor"), context(11))).json()).adjustments[0].photos)
      .toStrictEqual(cases[0].adjustments[0].photos);
  });

  it("uses a separate no-store document byte boundary for reception versus authorized clinicians", async () => {
    const photo = cases[0].adjustments[0].photos[0];
    const url = `/api/documents/${photo.id}`;
    vi.mocked(getDocumentForDownload).mockResolvedValue({ document: photo, storageKey: "synthetic-private-key" });
    vi.mocked(readFileByKey).mockResolvedValue(syntheticPng);
    const withheld = await download(request("reception", "", {}, url), context(photo.id));
    expect(withheld.status).toBe(403);
    expect(withheld.headers.get("cache-control")).toBe("private, no-store");
    expect(withheld.headers.get("content-disposition")).toBeNull();
    expect(Object.keys(await withheld.json())).toEqual(["message"]);
    expect(getDocumentForDownload).not.toHaveBeenCalled(); expect(readFileByKey).not.toHaveBeenCalled();

    for (const role of ["admin", "doctor"] as const) {
      const allowed = await download(request(role, "", {}, url), context(photo.id));
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("private, no-store");
      expect(allowed.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await allowed.arrayBuffer())).toEqual(syntheticPng);
    }
    expect(getDocumentForDownload).toHaveBeenCalledTimes(2);
    expect(readFileByKey).toHaveBeenCalledTimes(2);
    expect(owns).toHaveBeenCalledWith(7, 101);
  });

  it.each([true, false])("honors canViewAllPatients independently of image access %s", async (canViewXrays) => {
    const req = request("doctor", "", { canViewAllPatients: true, canViewXrays });
    const body = await (await list(req)).json();
    expect(body.cases.map((row: OrthoCase) => row.id)).toEqual([11, 22, 33]);
    for (const row of body.cases) {
      expect(row.photosVisible).toBe(canViewXrays);
      expect(row.adjustments[0].photos.length).toBe(canViewXrays ? 1 : 0);
    }
    expect(owns).not.toHaveBeenCalled();
  });

  it("withholds image metadata consistently on global/scoped/direct GET while preserving clinical records", async () => {
    for (const suffix of ["", "?patientId=101"]) {
      const req = request("doctor", suffix, { canViewXrays: false });
      const body = await (await list(req)).json();
      expect(body.cases).toEqual([cases[0], cases[2]].map((row) => ({
        ...row, photosVisible: false, adjustments: row.adjustments.map((entry) => ({ ...entry, photos: [] })),
      })));
      expect(JSON.stringify(body)).not.toContain("Synthetic private image note");
    }
    const req = request("doctor", "", { canViewXrays: false });
    expect(await (await detail(req, context(11))).json()).toEqual({
      ...cases[0], photosVisible: false, adjustments: cases[0].adjustments.map((entry) => ({ ...entry, photos: [] })),
    });
    // No mutation of the shared hydrated object can destroy photos for another authorized reader.
    expect(cases[0].adjustments[0].photos).toHaveLength(1);
    vi.mocked(getDocumentForDownload).mockResolvedValue({ document: cases[0].adjustments[0].photos[0], storageKey: "synthetic" });
    expect((await download(req, context(cases[0].adjustments[0].photos[0].id))).status).toBe(403);
    expect(readFileByKey).not.toHaveBeenCalled();
  });

  it.each(["missing", "inactive", "unlinked", "user-error", "ownership-error"])("fails closed for %s", async (failure) => {
    const req = request();
    if (failure === "missing") userByName.mockResolvedValue(null);
    if (failure === "inactive") userByName.mockResolvedValue({ ...user(), isActive: false });
    if (failure === "unlinked") userByName.mockResolvedValue({ ...user(), partyId: null });
    if (failure === "user-error") userByName.mockRejectedValue(new Error("Synthetic private diagnostic"));
    if (failure === "ownership-error") owns.mockRejectedValue(new Error("Synthetic private diagnostic"));
    expect((await (await list(req)).json()).cases).toEqual([]);
    expect((await detail(req, context(11))).status).toBe(403);
  });

  it("withholds photos if the image permission lookup fails after clinical authorization", async () => {
    const req = request("doctor", "?patientId=101");
    userByName.mockResolvedValueOnce(user()).mockRejectedValue(new Error("Synthetic image lookup failure"));
    const body = await (await list(req)).json();
    expect(body.cases).toHaveLength(2);
    expect(body.cases.every((row: { photosVisible: boolean }) => row.photosVisible === false)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("Synthetic private image note");
  });

  it("does not cache permission decisions across requests", async () => {
    expect((await (await list(request())).json()).cases).toHaveLength(2);
    owns.mockResolvedValue(false);
    expect((await (await list(request())).json()).cases).toEqual([]);
  });

  it.each(["assistant", "cashier", "accountant"] as const)("keeps the existing proxy prohibition for %s", async (role) => {
    const req = request(role);
    expect((await proxy(req)).status).toBe(403);
    if (role !== "assistant") expect((await (await list(req)).json()).cases).toEqual([]);
    expect(patientHasVisitToday).not.toHaveBeenCalled();
  });

  it("bounds concurrent checks and memoizes repeated case patients", async () => {
    const req = request();
    globalCases.mockResolvedValue(Array.from({ length: 50 }, (_, i) => fixture(100 + i, 1000 + (i % 25))));
    let active = 0; let peak = 0;
    owns.mockImplementation(async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1; return true;
    });
    expect((await (await list(req)).json()).cases).toHaveLength(50);
    expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(8);
    expect(owns).toHaveBeenCalledTimes(50); // Clinical and image checks, once each per distinct patient.
    expect(userByName).toHaveBeenCalledTimes(50);
  });

  it("returns a generic error without data or diagnostics on case query failure", async () => {
    const req = request(); globalCases.mockRejectedValue(new Error("Synthetic private diagnostic"));
    const response = await list(req);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ message: "تعذّر تحميل حالات التقويم." });
  });
});

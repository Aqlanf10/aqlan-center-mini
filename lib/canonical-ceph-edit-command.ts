import "server-only";
import { getPool, type CephCalibrationInput } from "./db";
import { isCephLandmarkCode, type LandmarkCode } from "./ceph";
import { cephDraftVersionWith } from "./canonical-ceph-draft-version";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { assertStaffOperation, staffOperationIdentity, staffOperationPatientScope, withStaffOperation } from "./staff-operation-runtime";
export class CanonicalCephEditRefusal extends Error {
  constructor(readonly code: "invalid_ceph_edit" | "ceph_edit_not_found" | "ceph_edit_conflict" | "ceph_edit_reference_invalid" | "ceph_contract_alignment_pending", readonly status: 400 | 404 | 409, message: string) { super(message); this.name = "CanonicalCephEditRefusal"; }
}
const missing = () => new CanonicalCephEditRefusal("ceph_edit_not_found", 404, "المسودة غير متاحة ضمن مرضاك.");
const conflict = () => new CanonicalCephEditRefusal("ceph_edit_conflict", 409, "تغيّرت المسودة أو تعذّر تثبيت حالتها. أعد قراءتها وراجع التعديلات قبل حفظ جديد.");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
type Diagnosis = { skeletal: string | null; dental: string | null; softTissue: string | null; note: string | null; finalDx: string };
type Landmark = { code: LandmarkCode; x: number; y: number; source: "manual" | "suggested" };
export function parseCanonicalCephEdit(rawId: string, body: unknown) {
  const id = Number(rawId), invalid = () => new CanonicalCephEditRefusal("invalid_ceph_edit", 400, "راجع حقول المسودة وقيمها؛ لا نحذف معالم غير صالحة أو نختصر التشخيص تلقائيًا.");
  if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || id > 2147483647 || !object(body)) throw invalid();
  const keys = Object.keys(body);
  if (keys.length < 2 || keys.some(key => !["expectedVersion", "calibration", "landmarks", "diagnosis"].includes(key)) || typeof body.expectedVersion !== "string" || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) throw invalid();
  let calibration: CephCalibrationInput | undefined, landmarks: Landmark[] | undefined, diagnosis: Diagnosis | undefined;
  if (Object.hasOwn(body, "calibration")) {
    const c = body.calibration;
    if (!object(c) || Object.keys(c).sort().join(",") !== "mm,x1,x2,y1,y2" || !finite(c.x1) || !finite(c.y1) || !finite(c.x2) || !finite(c.y2) || !finite(c.mm) || c.mm <= 0) throw invalid();
    const px = Math.hypot(c.x2 - c.x1, c.y2 - c.y1), scale = c.mm / px;
    if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(scale) || scale <= 0) throw invalid();
    calibration = { x1: c.x1, y1: c.y1, x2: c.x2, y2: c.y2, mm: c.mm };
  }
  if (Object.hasOwn(body, "landmarks")) {
    if (!Array.isArray(body.landmarks) || !body.landmarks.length || body.landmarks.length > 256) throw invalid();
    const seen = new Set<string>(); landmarks = body.landmarks.map(p => {
      if (!object(p) || Object.keys(p).sort().join(",") !== "code,source,x,y" || !isCephLandmarkCode(p.code) || !finite(p.x) || !finite(p.y) || (p.source !== "manual" && p.source !== "suggested") || seen.has(p.code)) throw invalid();
      seen.add(p.code); return { code: p.code, x: p.x, y: p.y, source: p.source as Landmark["source"] };
    });
  }
  if (Object.hasOwn(body, "diagnosis")) {
    const d = body.diagnosis;
    if (!object(d) || Object.keys(d).sort().join(",") !== "dental,finalDx,note,skeletal,softTissue" || typeof d.finalDx !== "string" || !d.finalDx.trim() || d.finalDx.trim().length > 2000) throw invalid();
    const clean = (value: unknown): string | null => { if (value === null) return null; if (typeof value !== "string" || value.trim().length > 2000) throw invalid(); return value.trim() || null; };
    diagnosis = { skeletal: clean(d.skeletal), dental: clean(d.dental), softTissue: clean(d.softTissue), note: clean(d.note), finalDx: d.finalDx.trim() };
  }
  return { id, expectedVersion: body.expectedVersion, calibration, landmarks, diagnosis };
}

/** Atomic explicit edits of one observed draft. No completion, engine invocation or image authority. */
/**
 * Held on the integration branch (2026-11-12). This canonical writer was built on the earlier
 * cephalometric contract; staging's protected writers (completion snapshot, sources, provenance,
 * witness, landmark/calibration checks) now own every ceph write. Until this command is re-aligned
 * with that contract it refuses before any read or write. The legacy route keeps staging's writer.
 */
export async function commandCanonicalCephEdit(_session: VerifiedDurableSession, rawId: string, body: unknown, _pool = getPool()): Promise<never> {
  parseCanonicalCephEdit(rawId, body);
  throw new CanonicalCephEditRefusal("ceph_contract_alignment_pending", 409, "تعديل دراسات السيفالو واعتمادها عبر هذا المسار موقوف مؤقتًا حتى مواءمته مع عقد الاعتماد الحالي (اللقطة والمصادر والأثر)؛ لم يُكتب شيء. استعمل شاشة السيفالو المعتادة.");
}

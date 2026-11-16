import "server-only";
import { CLINIC_TIME_ZONE } from "./db";
import { canonicalCephReadId, CanonicalCephReadRefusal } from "./canonical-ceph-reads";
import { CanonicalPatientReadRefusal, readCanonicalPatientRecord } from "./canonical-patient-reads";
import type { CanonicalSnapshotQuery, CanonicalSnapshotScope } from "./canonical-read-snapshot";
import type { VerifiedDurableSession } from "./staff-durable-session";
import { CEPH_IMAGE_CHOICES_PAGE, CEPH_ORTHO_CHOICES_LIMIT, isCanonicalCephCreateContext, type CanonicalCephCreateContext } from "./canonical-ceph-create-projection";
export function canonicalCephCreateQuery(rawId: string, params: URLSearchParams) {
  const patientId = canonicalCephReadId(rawId, new URLSearchParams(), true);
  if ([...params.keys()].some(k => !["create", "imagesBefore"].includes(k)) || params.getAll("create").length !== 1 || params.get("create") !== "1" || params.getAll("imagesBefore").length > 1) throw new CanonicalPatientReadRefusal("invalid_patient_query", "طلب خيارات الدراسة غير صالح.");
  const raw = params.get("imagesBefore"), imagesBefore = raw === null ? null : Number(raw);
  if (raw !== null && (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(imagesBefore) || imagesBefore! > 2147483647)) throw new CanonicalPatientReadRefusal("invalid_patient_query", "مؤشر صفحة الصور غير صالح.");
  return { patientId, imagesBefore };
}
export async function readCephCreateContextWith(q: CanonicalSnapshotQuery, scope: CanonicalSnapshotScope, patientId: number, imagesBefore: number | null): Promise<CanonicalCephCreateContext> {
  if (!scope.granted("clinical.xrays.upload")) throw new CanonicalPatientReadRefusal("patient_filter_not_granted", "لا تملك صلاحية فتح مسودة على صور المريض.");
  const images = (await q.query<{ id: number; title: string; taken_on: string | null; uploaded_at: Date }>(`SELECT id,CASE WHEN octet_length(title)<=8000 THEN title ELSE NULL END AS title,taken_on::text AS taken_on,uploaded_at FROM patient_documents
    WHERE patient_id=$1 AND removed_at IS NULL AND mime_type LIKE 'image/%' AND ($2::int IS NULL OR id<$2)
    ORDER BY id DESC LIMIT $3`, [patientId, imagesBefore, CEPH_IMAGE_CHOICES_PAGE + 1])).rows;
  const selected = images.slice(0, CEPH_IMAGE_CHOICES_PAGE);
  const previous = selected.length ? (await q.query<{ document_id: number; count: string }>("SELECT document_id,count(*)::text AS count FROM ceph_analyses WHERE patient_id=$1 AND document_id=ANY($2::int[]) AND status<>'discarded' GROUP BY document_id", [patientId, selected.map(i => i.id)])).rows : [];
  const orthoCases = scope.granted("clinical.ortho.view") ? (await q.query<{ id: number }>("SELECT id FROM ortho_cases WHERE patient_id=$1 ORDER BY id DESC LIMIT $2", [patientId, CEPH_ORTHO_CHOICES_LIMIT + 1])).rows : null;
  const referenceSets = (await q.query<{ key: string; name: string }>("SELECT CASE WHEN octet_length(key)<=240 THEN key ELSE NULL END AS key,CASE WHEN octet_length(name)<=8000 THEN name ELSE NULL END AS name FROM ceph_reference_sets WHERE active=TRUE ORDER BY id LIMIT 201")).rows;
  if ((orthoCases?.length ?? 0) > CEPH_ORTHO_CHOICES_LIMIT || referenceSets.length > 200) throw new CanonicalCephReadRefusal("ceph_read_limit", "خيارات الربط أو المراجع تتجاوز حد القراءة الآمنة؛ لم تُختصر الخيارات.");
  const { rows: [draft] } = await q.query<{ found: boolean }>("SELECT EXISTS(SELECT 1 FROM ceph_analyses WHERE patient_id=$1 AND status='draft') AS found", [patientId]);
  const result: CanonicalCephCreateContext = { projection: "ceph-create-context", patientId, clinicTimeZone: CLINIC_TIME_ZONE, imagesBefore, nextImagesBefore: images.length > CEPH_IMAGE_CHOICES_PAGE ? selected.at(-1)!.id : null, hasOpenDraft: draft.found,
    images: selected.map(i => ({ id: i.id, title: i.title, takenOn: i.taken_on, uploadedAt: i.uploaded_at.toISOString(), previousStudies: Number(previous.find(p => p.document_id === i.id)?.count ?? 0) })), orthoCases, referenceSets };
  if (!isCanonicalCephCreateContext(result, patientId, imagesBefore)) throw new CanonicalCephReadRefusal("ceph_stored_data_invalid", "تعذّر التحقق من خيارات الدراسة المحفوظة.");
  return result;
}
export function readCanonicalCephCreateContext(session: VerifiedDurableSession, patientId: number, imagesBefore: number | null = null) {
  return readCanonicalPatientRecord(session, "read:ceph.list", patientId, (q, scope) => readCephCreateContextWith(q, scope, patientId, imagesBefore), 2 * 1024 * 1024);
}

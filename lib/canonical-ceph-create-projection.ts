import { isKnownZone } from "./clinicZone";
export const CEPH_IMAGE_CHOICES_PAGE = 100;
export const CEPH_ORTHO_CHOICES_LIMIT = 300;
export interface CanonicalCephCreateContext {
  projection: "ceph-create-context";
  patientId: number;
  clinicTimeZone: string;
  imagesBefore: number | null;
  nextImagesBefore: number | null;
  hasOpenDraft: boolean;
  images: { id: number; title: string; takenOn: string | null; uploadedAt: string; previousStudies: number }[];
  /** No ortho facts without the independent view grant. */
  orthoCases: { id: number }[] | null;
  referenceSets: { key: string; name: string }[];
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: object, allowed: string[]) => Object.keys(v).sort().join(",") === allowed.sort().join(",");
const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
export function isCanonicalCephCreateContext(value: unknown, patientId: number, before: number | null): value is CanonicalCephCreateContext {
  if (!object(value) || !keys(value, ["projection", "patientId", "clinicTimeZone", "imagesBefore", "nextImagesBefore", "hasOpenDraft", "images", "orthoCases", "referenceSets"])) return false;
  const v = value as unknown as CanonicalCephCreateContext;
  if (v.projection !== "ceph-create-context" || v.patientId !== patientId || v.imagesBefore !== before || typeof v.clinicTimeZone !== "string" || !isKnownZone(v.clinicTimeZone) || typeof v.hasOpenDraft !== "boolean" || !Array.isArray(v.images) || v.images.length > CEPH_IMAGE_CHOICES_PAGE) return false;
  if (!v.images.every((row, index) => object(row) && keys(row, ["id", "title", "takenOn", "uploadedAt", "previousStudies"]) && positive(row.id) && (before === null || row.id < before) && (index === 0 || row.id < v.images[index - 1].id) && typeof row.title === "string" && row.title.length <= 8000 && (row.takenOn === null || typeof row.takenOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.takenOn)) && typeof row.uploadedAt === "string" && Number.isFinite(Date.parse(row.uploadedAt)) && Number.isSafeInteger(row.previousStudies) && row.previousStudies >= 0)) return false;
  if (v.nextImagesBefore !== null && (!positive(v.nextImagesBefore) || v.images.length !== CEPH_IMAGE_CHOICES_PAGE || v.nextImagesBefore !== v.images.at(-1)?.id)) return false;
  if (v.orthoCases !== null && (!Array.isArray(v.orthoCases) || v.orthoCases.length > CEPH_ORTHO_CHOICES_LIMIT || !v.orthoCases.every((row, index) => object(row) && keys(row, ["id"]) && positive(row.id) && (index === 0 || row.id < v.orthoCases![index - 1].id)))) return false;
  if (!Array.isArray(v.referenceSets) || v.referenceSets.length > 200 || new Set(v.referenceSets.map(s => s?.key)).size !== v.referenceSets.length || !v.referenceSets.every(s => object(s) && keys(s, ["key", "name"]) && typeof s.key === "string" && s.key.length > 0 && s.key.length <= 60 && typeof s.name === "string" && s.name.length > 0 && s.name.length <= 8000)) return false;
  return true;
}

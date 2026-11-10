import { immutableStorageRootIsProvisioned, putImmutableFile, readImmutableFileByKey } from "./files";
import { probeStorageReadiness } from "./storage-readiness";
import { storageKey } from "./storage";

export const MAX_STUDY_EXPORT_ARTIFACT_BYTES = 24 * 1024 * 1024;
export interface StudyExportArtifactReference { storageKey: string; sha256: string; sizeBytes: number }

async function requireStorage(): Promise<void> {
  try {
    if (!await immutableStorageRootIsProvisioned()) throw new Error("STUDY_EXPORT_STORAGE_UNAVAILABLE");
    const readiness = await probeStorageReadiness();
    if (readiness.level === "ready" && readiness.durable) return;
  } catch { /* Do not expose filesystem configuration or native errors. */ }
  throw new Error("STUDY_EXPORT_STORAGE_UNAVAILABLE");
}

/** Caller supplies server-rendered PPTX bytes, never a client path or key. */
export async function storeStudyExportArtifact(bytes: Uint8Array): Promise<StudyExportArtifactReference> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_STUDY_EXPORT_ARTIFACT_BYTES) throw new Error("STUDY_EXPORT_ARTIFACT_INVALID");
  const snapshot = Buffer.from(bytes); // Preserve the exact render across awaits.
  await requireStorage();
  try {
    const stored = await putImmutableFile(snapshot, "pptx");
    return { storageKey: stored.key, sha256: stored.sha256, sizeBytes: stored.sizeBytes };
  } catch { throw new Error("STUDY_EXPORT_ARTIFACT_WRITE_FAILED"); }
}

/** This verifies physical bytes only; canonical case/export authorization is
 * required at the calling route both before reading and before delivery. */
export async function readStudyExportArtifactBytes(reference: StudyExportArtifactReference): Promise<Uint8Array> {
  if (!reference || typeof reference.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(reference.sha256) ||
      !Number.isSafeInteger(reference.sizeBytes) || reference.sizeBytes < 1 || reference.sizeBytes > MAX_STUDY_EXPORT_ARTIFACT_BYTES ||
      reference.storageKey !== storageKey(reference.sha256, "pptx")) throw new Error("STUDY_EXPORT_ARTIFACT_INVALID");
  const { storageKey: key, sha256, sizeBytes } = reference;
  await requireStorage();
  try { return await readImmutableFileByKey(key, sha256, sizeBytes); }
  catch { throw new Error("STUDY_EXPORT_ARTIFACT_READ_FAILED"); }
}

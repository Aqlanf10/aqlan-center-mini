import path from "node:path";
import { mkdir, rm } from "node:fs/promises";
import { Client } from "pg";
import { sslForConnection, parseDatabaseHost } from "../db-tls";
import { classifyDbTarget } from "../db-target";
import { readBackupHistory } from "../backupHistory";
import {
  atomicWriteJson,
  backupStateDir,
  readJsonFile,
  resolveBackupArchivePath,
} from "../backupVolume";
import { stagedRestoreForVerifiedDrill } from "./staging";
import {
  numberingCutoverHold, type RestoreCutoverBlocker, type RestoreNumberingEvidence,
} from "./cutover-readiness";

export const RESTORE_DRILL_STATE_FILE = "restore-drill-state.json";

export type RestoreDrillUnavailableReason =
  | "missing-target"
  | "missing-classification"
  | "unsafe-classification"
  | "target-not-dedicated"
  | "production-collision";

type EnvironmentLike = Record<string, string | undefined>;

export interface RestoreDrillAvailability {
  available: boolean;
  targetEnvironment: "staging" | "test" | null;
  reason: RestoreDrillUnavailableReason | null;
}

export interface RestoreDrillState {
  backupId: string;
  requestedAt: string;
  completedAt: string | null;
  requestedBy: string;
  status: "running" | "restored" | "failed";
  targetEnvironment: "staging" | "test";
  archiveSha256: string;
  documentsVerified: number;
  tablesCount: number;
  durationMs: number | null;
  readyForCutover: false;
  patientNumberSequence: RestoreNumberingEvidence;
  cutoverBlocker: RestoreCutoverBlocker | null;
  errorCode: string | null;
}

function sameDatabaseTarget(first: string, second: string): boolean {
  const a = parseDatabaseHost(first);
  const b = parseDatabaseHost(second);
  if (!a || !b) return first.trim() === second.trim();
  return a.host === b.host && a.port === b.port && a.database === b.database;
}

/**
 * هدف الاستعادة التجريبية لا يأتي من DATABASE_URL الإنتاجي أبدًا.
 * يلزم URL مستقل + تصنيف staging/test + إعلان أنه هدف مخصص قابل للمسح.
 */
export function restoreDrillAvailability(
  env: EnvironmentLike = process.env,
): RestoreDrillAvailability {
  const targetUrl = env.RESTORE_DRILL_DATABASE_URL?.trim() ?? "";
  if (!targetUrl) return { available: false, targetEnvironment: null, reason: "missing-target" };

  const classification = env.RESTORE_DRILL_DATABASE_ENVIRONMENT?.trim().toLowerCase() ?? "";
  if (!classification) {
    return { available: false, targetEnvironment: null, reason: "missing-classification" };
  }
  if (classification !== "staging" && classification !== "test") {
    return { available: false, targetEnvironment: null, reason: "unsafe-classification" };
  }
  if ((env.RESTORE_DRILL_DEDICATED_TARGET ?? "").trim().toLowerCase() !== "true") {
    return { available: false, targetEnvironment: classification, reason: "target-not-dedicated" };
  }

  const target = classifyDbTarget(targetUrl, { ...process.env, ...env, DATABASE_ENVIRONMENT: classification });
  if (!target.allowsRestoreFull || (target.environment !== "staging" && target.environment !== "test")) {
    return { available: false, targetEnvironment: classification, reason: "unsafe-classification" };
  }

  const productionUrl = env.DATABASE_URL?.trim() ?? "";
  if (productionUrl && sameDatabaseTarget(targetUrl, productionUrl)) {
    return { available: false, targetEnvironment: classification, reason: "production-collision" };
  }

  return { available: true, targetEnvironment: classification, reason: null };
}

export async function readRestoreDrillState(backupDir: string): Promise<RestoreDrillState | null> {
  type RecordedDrill = Omit<RestoreDrillState, "status" | "readyForCutover" | "patientNumberSequence"> & {
    status: RestoreDrillState["status"] | "ready";
    readyForCutover?: unknown;
    patientNumberSequence?: unknown;
  };
  const read = await readJsonFile<RecordedDrill>(
    path.join(backupStateDir(backupDir), RESTORE_DRILL_STATE_FILE),
  );
  if (!read.ok || !read.data || typeof read.data !== "object") return null;
  const drill = read.data;
  if (drill.status === "ready" || drill.status === "restored") {
    // Historical 'ready' only attested isolated restore. Its true bit is
    // never authoritative, and historical evidence is not inferred.
    return {
      ...drill,
      status: "restored",
      ...numberingCutoverHold(drill.status === "ready" ? null : drill.patientNumberSequence),
    };
  }
  if (drill.status !== "failed" && drill.status !== "running") return null;
  return {
    ...drill, status: drill.status, readyForCutover: false,
    patientNumberSequence: "unverified", cutoverBlocker: null,
  };
}

async function writeRestoreDrillState(backupDir: string, state: RestoreDrillState): Promise<void> {
  await mkdir(backupStateDir(backupDir), { recursive: true });
  await atomicWriteJson(path.join(backupStateDir(backupDir), RESTORE_DRILL_STATE_FILE), state);
}

/** الهدف مخصص صراحةً للـdrill؛ يمسح قبل كل تشغيل كي تبقى التجربة قابلة للتكرار. */
async function resetDedicatedTarget(targetUrl: string): Promise<void> {
  const client = new Client({ connectionString: targetUrl, ssl: sslForConnection(targetUrl) });
  try {
    await client.connect();
    await client.query("BEGIN");
    try {
      await client.query("DROP SCHEMA IF EXISTS public CASCADE");
      await client.query("CREATE SCHEMA public");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

export type AdminRestoreDrillResult =
  | {
      ok: true;
      readyForCutover: false;
      patientNumberSequence: RestoreNumberingEvidence;
      cutoverBlocker: RestoreCutoverBlocker;
      backupId: string;
      archiveSha256: string;
      documentsVerified: number;
      tablesCount: number;
      durationMs: number;
      targetEnvironment: "staging" | "test";
    }
  | {
      ok: false;
      reason:
        | RestoreDrillUnavailableReason
        | "backup-not-found"
        | "archive-integrity-mismatch"
        | "canonical-fresh-target-required"
        | "restore-failed";
    };

/**
 * استعادة تجريبية حقيقية إلى هدف staging/test مخصص. لا يوجد في هذا المسار
 * أي كتابة إلى DATABASE_URL الإنتاجي، ولا cutover آلي.
 */
export async function runAdminRestoreDrill(input: {
  backupDir: string;
  backupId: string;
  actor: string;
  env?: EnvironmentLike;
}): Promise<AdminRestoreDrillResult> {
  const env = input.env ?? process.env;
  const availability = restoreDrillAvailability(env);
  if (!availability.available || !availability.targetEnvironment) {
    return { ok: false, reason: availability.reason ?? "unsafe-classification" };
  }

  const records = await readBackupHistory(input.backupDir);
  const record = records.find(
    (candidate) =>
      candidate.backupId === input.backupId
      && candidate.status === "verified"
      && !candidate.deletedAt,
  );
  if (!record) return { ok: false, reason: "backup-not-found" };

  let archivePath: string;
  try {
    archivePath = resolveBackupArchivePath(input.backupDir, input.backupId);
  } catch {
    return { ok: false, reason: "backup-not-found" };
  }

  const stagingDir = path.join(backupStateDir(input.backupDir), "restore-drill-current");
  const startedAt = new Date();
  const running: RestoreDrillState = {
    backupId: input.backupId,
    requestedAt: startedAt.toISOString(),
    completedAt: null,
    requestedBy: input.actor.slice(0, 120),
    status: "running",
    targetEnvironment: availability.targetEnvironment,
    archiveSha256: record.archiveSha256,
    documentsVerified: 0,
    tablesCount: 0,
    durationMs: null,
    readyForCutover: false,
    patientNumberSequence: "unverified",
    cutoverBlocker: null,
    errorCode: null,
  };
  let admitted = false;
  try {
    const targetUrl = env.RESTORE_DRILL_DATABASE_URL!.trim();
    const result = await stagedRestoreForVerifiedDrill({ archivePath, targetUrl, stagingDir }, {
      sha256: record.archiveSha256,
      bytes: record.archiveBytes,
      databaseSha256: record.databaseSha256,
      documents: record.documentCount,
    }, async () => {
      // Invoked only after compressed identity, archive and SQL validation.
      admitted = true;
      await writeRestoreDrillState(input.backupDir, running);
      await rm(stagingDir, { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: true });
      await resetDedicatedTarget(targetUrl);
    });
    if (!admitted) return { ok: false, reason: result.canonicalFreshTargetRequired ? "canonical-fresh-target-required" : "archive-integrity-mismatch" };
    const durationMs = Date.now() - startedAt.getTime();

    if (!result.ok) {
      await writeRestoreDrillState(input.backupDir, {
        ...running,
        completedAt: new Date().toISOString(),
        status: "failed",
        documentsVerified: result.documentsVerified,
        tablesCount: result.verification.tablesCount,
        durationMs,
        errorCode: "restore-failed",
      });
      return { ok: false, reason: "restore-failed" };
    }

    const hold = numberingCutoverHold(result.patientNumberSequence);
    await writeRestoreDrillState(input.backupDir, {
      ...running,
      ...hold,
      completedAt: new Date().toISOString(),
      status: "restored",
      documentsVerified: result.documentsVerified,
      tablesCount: result.verification.tablesCount,
      durationMs,
    });
    return {
      ok: true,
      ...hold,
      backupId: input.backupId,
      archiveSha256: record.archiveSha256,
      documentsVerified: result.documentsVerified,
      tablesCount: result.verification.tablesCount,
      durationMs,
      targetEnvironment: availability.targetEnvironment,
    };
  } catch {
    if (!admitted) return { ok: false, reason: "archive-integrity-mismatch" };
    const durationMs = Date.now() - startedAt.getTime();
    await writeRestoreDrillState(input.backupDir, {
      ...running,
      completedAt: new Date().toISOString(),
      status: "failed",
      durationMs,
      errorCode: "restore-failed",
    }).catch(() => {});
    return { ok: false, reason: "restore-failed" };
  }
}

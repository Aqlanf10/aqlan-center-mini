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
  verifyBackupArchiveFile,
} from "../backupVolume";
import { stagedRestore } from "./staging";

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
  status: "running" | "ready" | "failed";
  targetEnvironment: "staging" | "test";
  archiveSha256: string;
  documentsVerified: number;
  tablesCount: number;
  durationMs: number | null;
  readyForCutover: boolean;
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
  const read = await readJsonFile<RestoreDrillState>(
    path.join(backupStateDir(backupDir), RESTORE_DRILL_STATE_FILE),
  );
  return read.ok ? read.data : null;
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
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
  } finally {
    await client.end().catch(() => {});
  }
}

export type AdminRestoreDrillResult =
  | {
      ok: true;
      readyForCutover: true;
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
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  let verified;
  try {
    verified = await verifyBackupArchiveFile(archivePath, stagingDir);
  } catch {
    return { ok: false, reason: "archive-integrity-mismatch" };
  }
  if (
    verified.sha256 !== record.archiveSha256
    || verified.bytes !== record.archiveBytes
    || verified.databaseSha256 !== record.databaseSha256
    || verified.documents !== record.documentCount
  ) {
    return { ok: false, reason: "archive-integrity-mismatch" };
  }

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
    errorCode: null,
  };
  await writeRestoreDrillState(input.backupDir, running);

  try {
    const targetUrl = env.RESTORE_DRILL_DATABASE_URL!.trim();
    await resetDedicatedTarget(targetUrl);
    const result = await stagedRestore({
      archivePath,
      targetUrl,
      stagingDir,
      allowNonEmptyTarget: false,
    });
    const durationMs = Date.now() - startedAt.getTime();

    if (!result.ok || !result.readyForCutover) {
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

    await writeRestoreDrillState(input.backupDir, {
      ...running,
      completedAt: new Date().toISOString(),
      status: "ready",
      documentsVerified: result.documentsVerified,
      tablesCount: result.verification.tablesCount,
      durationMs,
      readyForCutover: true,
    });
    return {
      ok: true,
      readyForCutover: true,
      backupId: input.backupId,
      archiveSha256: record.archiveSha256,
      documentsVerified: result.documentsVerified,
      tablesCount: result.verification.tablesCount,
      durationMs,
      targetEnvironment: availability.targetEnvironment,
    };
  } catch {
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

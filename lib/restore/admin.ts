import path from "node:path";
import { assertNoAmbientPgOptions, parseRestoreIdentity } from "./target-identity.mjs";
import { assertNoScopedRestoreCollision } from "./target-scope";
import { createRestoreClientSnapshot, restoreConfigFromSnapshot } from "./client-config";
import { classifyDbTarget } from "../db-target";
import { readBackupHistory } from "../backupHistory";
import {
  backupStateDir,
  readJsonFile,
  resolveBackupArchivePath,
} from "../backupVolume";
import { readTarGzSnapshot } from "./archive";
import { validateBackupArchive } from "./validate";
import { prepareBackupSql } from "./sql.mjs";
import { createRestoreMigrationSnapshot } from "./migration-catalog";

export const RESTORE_DRILL_STATE_FILE = "restore-drill-state.json";

export type RestoreDrillUnavailableReason =
  | "missing-target"
  | "missing-classification"
  | "unsafe-classification"
  | "target-not-dedicated"
  | "production-collision"
  | "restore-temporarily-disabled";

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

/**
 * هدف الاستعادة التجريبية لا يأتي من DATABASE_URL الإنتاجي أبدًا.
 * يلزم URL مستقل + تصنيف staging/test + إعلان أنه هدف مخصص قابل للمسح.
 */
export function restoreDrillAvailability(
  env: EnvironmentLike = process.env,
  ambient: EnvironmentLike = process.env,
): RestoreDrillAvailability {
  const targetUrl = env.RESTORE_DRILL_DATABASE_URL ?? "";
  if (!targetUrl.trim()) return { available: false, targetEnvironment: null, reason: "missing-target" };

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

  let identity;
  try {
    assertNoAmbientPgOptions(ambient, env);
    identity = parseRestoreIdentity(targetUrl, { target:true });
    assertNoScopedRestoreCollision(identity, ambient, env);
  } catch (error) {
    return { available:false, targetEnvironment:classification,
      reason:error instanceof Error && error.message === "RESTORE_TARGET_COLLISION" ? "production-collision" : "unsafe-classification" };
  }
  const target = classifyDbTarget(identity.connectionString, { ...ambient, ...env, DATABASE_ENVIRONMENT: classification } as unknown as NodeJS.ProcessEnv);
  if (!target.allowsRestoreFull || (target.environment !== "staging" && target.environment !== "test")) {
    return { available: false, targetEnvironment: classification, reason: "unsafe-classification" };
  }

  return { available: true, targetEnvironment: classification, reason: null };
}

/** Configuration may be valid, but execution is suspended until isolation is proven. */
export function restoreDrillExecutionAvailability(env: EnvironmentLike = process.env): RestoreDrillAvailability {
  const target=restoreDrillAvailability(env);
  return target.available ? { available:false, targetEnvironment:target.targetEnvironment, reason:"restore-temporarily-disabled" } : target;
}

export async function readRestoreDrillState(backupDir: string): Promise<RestoreDrillState | null> {
  const read = await readJsonFile<RestoreDrillState>(
    path.join(backupStateDir(backupDir), RESTORE_DRILL_STATE_FILE),
  );
  return read.ok ? read.data : null;
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

/** Validate the prior drill inputs, then refuse execution while isolation is unproven. */
export async function runAdminRestoreDrill(input: {
  backupDir: string;
  backupId: string;
  actor: string;
  env?: EnvironmentLike;
}): Promise<AdminRestoreDrillResult> {
  const env = { ...(input.env ?? process.env) };
  const ambient = { ...process.env };
  const availability = restoreDrillAvailability(env, ambient);
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
  let archiveSnapshot: Awaited<ReturnType<typeof readTarGzSnapshot>>["archive"];
  let migrationFilesSnapshot: Awaited<ReturnType<typeof createRestoreMigrationSnapshot>>;
  try {
    // One immutable read supplies both verification and restoration. Otherwise
    // replacing the on-disk archive between precheck and reset could invalidate
    // the precheck. No target or prior staged document is touched in this block.
    const snapshot = await readTarGzSnapshot(archivePath);
    if (snapshot.bytes !== record.archiveBytes || snapshot.sha256 !== record.archiveSha256) {
      return { ok: false, reason: "archive-integrity-mismatch" };
    }
    archiveSnapshot = snapshot.archive;
    const validated = validateBackupArchive(archiveSnapshot, { documentsDir: stagingDir });
    if (!validated.ok || validated.sqlSha256 !== record.databaseSha256
        || validated.documents.length !== record.documentCount) {
      return { ok: false, reason: "archive-integrity-mismatch" };
    }
    // Reject a forged, missing or contradictory historical 0079 record BEFORE
    // reset; stagedRestore rechecks this same snapshot before its own writes.
    migrationFilesSnapshot = await createRestoreMigrationSnapshot();
    if (!Array.isArray(migrationFilesSnapshot) || !migrationFilesSnapshot.length) throw new Error("Restore migration catalogue unavailable.");
    prepareBackupSql(Buffer.from(validated.sql).toString("utf8"), { inspectHistorical0079: true, migrationFiles: migrationFilesSnapshot });
  } catch {
    return { ok: false, reason: "archive-integrity-mismatch" };
  }

  // Preserve archive and target identity validation, but suspend the drill
  // before touching the prior stage, opening a restore client, or mutating
  // the target. A dedicated-target declaration does not establish isolation.
  try {
    const targetSnapshot = createRestoreClientSnapshot(env.RESTORE_DRILL_DATABASE_URL!, env);
    restoreConfigFromSnapshot(targetSnapshot, targetSnapshot.targetUrl);
  } catch { return { ok:false, reason:"unsafe-classification" }; }
  return { ok:false, reason:"restore-temporarily-disabled" };
}

import { and, count, desc, eq, gte, ilike, lt, or } from "drizzle-orm";

import { db } from "@/lib/db";
import { auditLogs, users } from "@/db/schema";
import { AUDIT_ACTIONS } from "@/server/audit";
import { zonedTimeToUtc } from "@/lib/datetime";

export const AUDIT_PAGE_SIZE = 25;

/**
 * Sensitive metadata keys that must never be rendered in the viewer.
 * Defense in depth: writes already avoid secrets, the reader filters too.
 */
const BLOCKED_METADATA_KEYS = new Set([
  "password",
  "newpassword",
  "currentpassword",
  "passwordhash",
  "hash",
  "secret",
  "authsecret",
  "databaseurl",
  "token",
  "sessiontoken",
  "credentials",
]);

/** Redact unsafe metadata values, keep a short safe summary. */
export function safeMetadataSummary(
  metadata: Record<string, unknown> | null | undefined
): string {
  if (!metadata) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(metadata)) {
    const lower = key.toLowerCase();
    if (BLOCKED_METADATA_KEYS.has(lower) || lower.includes("password")) {
      continue; // never render anything password-ish
    }
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      parts.push(`${key}=${String(value)}`);
    } else if (value === null || value === undefined) {
      // skip nulls entirely
    } else {
      parts.push(`${key}=${JSON.stringify(value)}`);
    }
    if (parts.length >= 8) break; // keep the summary bounded
  }
  return parts.join(" · ").slice(0, 300);
}

export type AuditFilters = {
  /** ISO date (YYYY-MM-DD) — filter by that clinic day (Asia/Aden). */
  date?: string;
  userId?: string;
  action?: string;
  entityType?: string;
  q?: string; // free text on entity id / action
  page?: number;
};

export type AuditRow = {
  id: string;
  createdAt: Date;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  metadataSummary: string;
};

export type AuditResult = {
  rows: AuditRow[];
  total: number;
  page: number;
  pageCount: number;
};

/** Valid filter values for the UI dropdowns. */
export const AUDIT_ACTION_OPTIONS: readonly string[] = Object.values(AUDIT_ACTIONS);
export const AUDIT_ENTITY_OPTIONS = [
  "patient",
  "appointment",
  "visit",
  "contact",
  "payment",
  "charge",
  "user",
  "settings",
] as const;

/** Resolve an ISO date to the clinic-day UTC range (Asia/Aden, UTC+3 fixed). */
function isoDateToDayRangeUtc(iso: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return null;
  const start = zonedTimeToUtc({ year: y, month: m, day: d });
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * Paginated audit trail query. Read-only — the viewer offers no delete.
 */
export async function listAuditLogs(filters: AuditFilters): Promise<AuditResult> {
  const page = Math.max(1, filters.page ?? 1);

  const conditions = [];
  if (filters.date) {
    const day = isoDateToDayRangeUtc(filters.date);
    if (day) {
      conditions.push(gte(auditLogs.createdAt, day.start));
      conditions.push(lt(auditLogs.createdAt, day.end));
    }
  }
  if (filters.userId) {
    conditions.push(eq(auditLogs.userId, filters.userId));
  }
  if (filters.action && AUDIT_ACTION_OPTIONS.includes(filters.action)) {
    conditions.push(eq(auditLogs.action, filters.action));
  }
  if (
    filters.entityType &&
    (AUDIT_ENTITY_OPTIONS as readonly string[]).includes(filters.entityType)
  ) {
    conditions.push(eq(auditLogs.entityType, filters.entityType));
  }
  if (filters.q?.trim()) {
    const pattern = `%${filters.q.trim().replace(/[%_]/g, (m) => `\\${m}`)}%`;
    conditions.push(
      or(ilike(auditLogs.entityId, pattern), ilike(auditLogs.action, pattern))
    );
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, totals] = await Promise.all([
    db
      .select({
        id: auditLogs.id,
        createdAt: auditLogs.createdAt,
        actorName: users.name,
        action: auditLogs.action,
        entityType: auditLogs.entityType,
        entityId: auditLogs.entityId,
        metadata: auditLogs.metadata,
      })
      .from(auditLogs)
      .leftJoin(users, eq(auditLogs.userId, users.id))
      .where(where)
      .orderBy(desc(auditLogs.createdAt))
      .limit(AUDIT_PAGE_SIZE)
      .offset((page - 1) * AUDIT_PAGE_SIZE),
    db.select({ value: count() }).from(auditLogs).where(where),
  ]);

  const total = Number(totals[0]?.value ?? 0);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      actorName: row.actorName,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      metadataSummary: safeMetadataSummary(row.metadata),
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
  };
}

/** Staff list for the actor filter dropdown. */
export async function listAuditActors() {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .orderBy(users.name)
    .limit(100);
}

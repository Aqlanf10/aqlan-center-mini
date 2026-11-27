import type { DbClient } from "./db";
import type { Role } from "./roles";
import type { DoctorPermissions } from "./doctor-permissions";

export type AiToolGroup =
  | "clinical_guidance"
  | "appointments_schedule"
  | "patient_lookup"
  | "clinic_finance"
  | "own_commissions"
  | "inventory_lab";

export interface AiBudgetCheckResult {
  allowed: boolean;
  code?: "AI_BUDGET_EXCEEDED";
  reasonAr?: string;
  dailySpentMinor?: number;
  dailyLimitMinor?: number;
  monthlySpentMinor?: number;
  monthlyLimitMinor?: number;
}

/**
 * Per-staff AI tool-group isolation (Charter §21 / #608):
 * Deny > Allow across explicit UserPermissions and role boundaries.
 */
export function allowedAiToolGroupsForUser(
  role: Role,
  permissions?: (Partial<DoctorPermissions> & { canUseAiAssistant?: boolean; canUseAiChat?: boolean }) | null,
): ReadonlySet<AiToolGroup> {
  const groups = new Set<AiToolGroup>();
  if (permissions?.canUseAiAssistant === false || permissions?.canUseAiChat === false) {
    return groups;
  }

  groups.add("appointments_schedule");
  groups.add("patient_lookup");

  if (role === "admin" || role === "doctor") {
    groups.add("clinical_guidance");
  }

  const canFinance =
    role === "reception"
      ? false
      : permissions?.canViewClinicFinance ?? role === "admin";
  if (canFinance) {
    groups.add("clinic_finance");
  }

  const canOwnCommissions =
    role === "reception"
      ? false
      : permissions?.canViewOwnCommissions ?? (role === "doctor" || role === "admin");
  if (canOwnCommissions) {
    groups.add("own_commissions");
  }

  if (role === "admin" || role === "reception") {
    groups.add("inventory_lab");
  }

  return groups;
}

async function hasTable(runner: Pick<DbClient, "query">, regclassName: string): Promise<boolean> {
  try {
    const { rows } = await runner.query<{ reg: string | null }>(
      "SELECT to_regclass($1)::text AS reg",
      [regclassName],
    );
    return Boolean(rows[0]?.reg);
  } catch {
    return false;
  }
}

/**
 * Atomic budget pre-check before any external AI call (Proposal 0142).
 * Uses `FOR UPDATE` on `ai_budget_policies` when present so concurrent external requests
 * cannot race past daily/monthly spend caps. Local engine always remains available.
 */
export async function checkAiExternalBudget(
  runner: Pick<DbClient, "query">,
  scope = "global",
  estimatedRequestCostMinor = 1,
): Promise<AiBudgetCheckResult> {
  if (!(await hasTable(runner, "public.ai_budget_policies"))) {
    return { allowed: true };
  }
  const { rows: policies } = await runner.query<{
    monthly_limit_minor: string | number;
    daily_limit_minor: string | number;
    currency: string;
    enabled: boolean;
  }>(
    `SELECT monthly_limit_minor, daily_limit_minor, currency, enabled
       FROM ai_budget_policies
      WHERE scope = $1
      FOR UPDATE`,
    [scope],
  );
  const policy = policies[0];
  if (!policy || !policy.enabled) {
    return { allowed: true };
  }

  const dailyLimit = Number(policy.daily_limit_minor);
  const monthlyLimit = Number(policy.monthly_limit_minor);
  if (!(await hasTable(runner, "public.ai_usage_ledger"))) {
    return { allowed: true };
  }

  const { rows: totals } = await runner.query<{
    daily_spent: string | number;
    monthly_spent: string | number;
  }>(
    `SELECT
       COALESCE(SUM(estimated_cost_minor) FILTER (WHERE created_at >= date_trunc('day', NOW())), 0) AS daily_spent,
       COALESCE(SUM(estimated_cost_minor) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0) AS monthly_spent
     FROM ai_usage_ledger
     WHERE scope = $1 AND local_only = FALSE AND currency = $2`,
    [scope, policy.currency],
  );

  const dailySpent = Number(totals[0]?.daily_spent ?? 0);
  const monthlySpent = Number(totals[0]?.monthly_spent ?? 0);

  if (dailySpent + estimatedRequestCostMinor > dailyLimit) {
    return {
      allowed: false,
      code: "AI_BUDGET_EXCEEDED",
      reasonAr: "تم بلوغ السقف اليومي لميزانية المزوّد الخارجي؛ يستمر المساعد المحلي بالعمل دون تكلفة خارجية.",
      dailySpentMinor: dailySpent,
      dailyLimitMinor: dailyLimit,
      monthlySpentMinor: monthlySpent,
      monthlyLimitMinor: monthlyLimit,
    };
  }

  if (monthlySpent + estimatedRequestCostMinor > monthlyLimit) {
    return {
      allowed: false,
      code: "AI_BUDGET_EXCEEDED",
      reasonAr: "تم بلوغ السقف الشهري لميزانية المزوّد الخارجي؛ يستمر المساعد المحلي بالعمل دون تكلفة خارجية.",
      dailySpentMinor: dailySpent,
      dailyLimitMinor: dailyLimit,
      monthlySpentMinor: monthlySpent,
      monthlyLimitMinor: monthlyLimit,
    };
  }

  return {
    allowed: true,
    dailySpentMinor: dailySpent,
    dailyLimitMinor: dailyLimit,
    monthlySpentMinor: monthlySpent,
    monthlyLimitMinor: monthlyLimit,
  };
}

export async function recordAiUsageLedger(
  runner: Pick<DbClient, "query">,
  entry: {
    userId: number;
    username: string;
    role: string;
    scope: string;
    providerId?: string | null;
    model?: string | null;
    promptTokens?: number;
    completionTokens?: number;
    estimatedCostMinor?: number;
    currency?: "USD" | "SAR" | "YER";
    localOnly: boolean;
  },
): Promise<void> {
  if (!(await hasTable(runner, "public.ai_usage_ledger"))) return;
  await runner.query(
    `INSERT INTO ai_usage_ledger (
       user_id, username, role, scope, provider_id, model,
       prompt_tokens, completion_tokens, estimated_cost_minor, currency, local_only
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      entry.userId,
      entry.username,
      entry.role,
      entry.scope,
      entry.providerId ?? null,
      entry.model ?? null,
      Math.max(0, Math.trunc(entry.promptTokens ?? 0)),
      Math.max(0, Math.trunc(entry.completionTokens ?? 0)),
      Math.max(0, Math.trunc(entry.estimatedCostMinor ?? 0)),
      entry.currency ?? "USD",
      entry.localOnly,
    ],
  );
}

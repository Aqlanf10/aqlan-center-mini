import "server-only";
import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "./security-limits";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import {
  MAX_PASSWORD_LENGTH,
  SESSION_COOKIE,
  hashPassword,
} from "./auth";
import {
  doctorCommissionAuditInput,
  doctorCommissionChangeOn,
  doctorOwnsPatient,
  getPool,
  insertAuditRow,
  usesSharedLocalDatabaseConnection,
  type DbClient,
} from "./db";
import {
  parseDoctorCommissionConfig,
  validateDoctorCommissionConfigInput,
  type DoctorCommissionConfig,
} from "./doctor-permissions";
import { isRole } from "./roles";
import { staffSessionCookieSecure } from "./sessionCookie";
import { withIsolation } from "./transactions";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { staffIdentitySchemaName } from "./staff-identity-substrate-schema.mjs";
import { staffLifecycleLockKey } from "./legacy-staff-schema.mjs";
import {
  loadAdministrativeTargetState,
  loadExclusiveWriterAuthority,
} from "./staff-authority-proof-internal";
import {
  hasStaffCapability,
  validateStaffAccountChange,
  type StaffAccountOperation,
} from "./staff-capabilities";
import { StaffCapabilityEditError, staffAdmissionRefusal } from "./staff-capability-editor";
import { changeCanonicalStaffOwnPassword } from "./staff-durable-issuer";
import {
  revalidateVerifiedDurableSession,
  type VerifiedDurableSession,
} from "./staff-durable-session";
import {
  staffOperationIdentity,
  withStaffOperation,
} from "./staff-operation-runtime";
import { withCanonicalSelfSession } from "./staff-session-admission";

const MIN_PASSWORD_LENGTH = 8;
const PRINT_DOC_TYPES = ["receipt", "invoice", "voucher", "statement", "prescription", "card"] as const;

const usersJson = (body: unknown, status = 200): NextResponse =>
  NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

async function canonicalUsersXid(client: DbClient): Promise<string> {
  await client.query("SAVEPOINT canonical_users_xid_check");
  await client.query("RELEASE SAVEPOINT canonical_users_xid_check");
  const { rows } = await client.query<{ xid: string; isolation: string }>(
    "SELECT pg_current_xact_id()::text AS xid, current_setting('transaction_isolation') AS isolation",
  );
  if (rows.length !== 1 || rows[0].isolation !== "read committed") {
    throw new Error("STAFF_OPERATION_TRANSACTION_REQUIRED");
  }
  return rows[0].xid;
}

function mapCanonicalUsersRefusal(error: unknown, fallbackMessage: string): NextResponse {
  const refusal = staffAdmissionRefusal(error);
  if (refusal) return usersJson({ message: refusal.message }, refusal.status);
  return usersJson({ message: fallbackMessage }, 500);
}

interface CanonicalProjectedUserRow {
  id: number;
  username: string;
  display_name: string;
  role: string;
  is_active: boolean;
  created_at: Date;
  party_id: number | null;
  party_name: string | null;
  specialty: string | null;
  branch: string | null;
  commission_config: string | null;
  is_owner: boolean | null;
  owner_user_id: number | null;
}

function projectCanonicalUserRow(row: CanonicalProjectedUserRow, canSeeCommission: boolean) {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    partyId: row.party_id ?? null,
    partyName: row.party_name ?? null,
    specialty: row.specialty ?? null,
    branch: row.branch ?? null,
    isOwner: Boolean(row.is_owner || (row.owner_user_id !== null && row.id === row.owner_user_id)),
    ...(canSeeCommission ? { commissionConfig: parseDoctorCommissionConfig(row.commission_config) } : {}),
  };
}

export async function canonicalUsersGet(session: VerifiedDurableSession): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return usersJson({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  }
  try {
    const users = await runCanonicalReadSnapshot(
      session,
      "staff.view",
      async (query, scope) => {
        const canSeeCommission =
          scope.granted("finance.commissions.view-all") || scope.granted("finance.commissions.manage-rates");
        const { rows } = await query.query<CanonicalProjectedUserRow>(
          `SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.created_at,
                  CASE WHEN p.id IS NOT NULL THEN u.party_id ELSE NULL END AS party_id,
                  p.name AS party_name,
                  u.specialty, u.branch, u.commission_config, u.is_owner,
                  sac.owner_user_id
             FROM users u
             LEFT JOIN parties p ON p.id = u.party_id AND p.kind = 'doctor' AND p.is_active
             LEFT JOIN staff_authority_control sac ON sac.singleton = TRUE
            ORDER BY u.is_active DESC, u.created_at, u.id`,
        );
        return rows.map((row) => projectCanonicalUserRow(row, canSeeCommission));
      },
      { errorPrefix: "STAFF_READ", maxBytes: 1_048_576 },
    );
    return usersJson(users, 200);
  } catch (error) {
    return mapCanonicalUsersRefusal(error, "تعذّر تحميل المستخدمين.");
  }
}

export async function canonicalUsersPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return usersJson({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  }
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return usersJson({ message: "طلب غير صالح." }, 400);
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const username = typeof source.username === "string" ? source.username.trim() : "";
  const displayName = typeof source.displayName === "string" ? source.displayName.trim() : "";
  const password = typeof source.password === "string" ? source.password : "";

  try {
    return await withStaffOperation(getPool(), session, "staff.accounts.create", async (client, opHandle) => {
      const identity = await staffOperationIdentity(client, opHandle, "staff.accounts.create");
      if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
        return usersJson({ message: "اسم الدخول بالإنجليزية والأرقام فقط، من 3 إلى 32 حرفًا." }, 400);
      }
      if (!displayName || displayName.length > 80) {
        return usersJson({ message: "اكتب الاسم الظاهر." }, 400);
      }
      if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
        return usersJson(
          { message: `كلمة المرور يجب أن تكون بين 8 و${MAX_PASSWORD_LENGTH} حرفًا.` },
          400,
        );
      }
      if (!isRole(source.role)) {
        return usersJson({ message: "اختر الدور." }, 400);
      }
      if (source.commissionConfig !== undefined && source.commissionConfig !== null) {
        const checked = validateDoctorCommissionConfigInput(source.commissionConfig);
        if (!checked.ok) return usersJson({ message: checked.message }, 400);
      }

      const duplicate = await client.query<{ id: number }>(
        "SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1",
        [username],
      );
      if ((duplicate.rowCount ?? 0) > 0) {
        return usersJson({ message: "اسم الدخول مستخدم بالفعل." }, 409);
      }

      const state = await client.query<{ status: string }>(
        "SELECT status FROM staff_identity_state WHERE singleton = TRUE",
      );
      if (state.rows[0]?.status === "ready") {
        // Pre-B2 substrate invariant: ready state binds existing canonical subjects 1-to-1;
        // creating an unbound users row while ready would violate single-account onboarding (B2).
        return usersJson(
          {
            code: "ready_identity_account_create_requires_b2",
            message: "إنشاء حساب موظف جديد أثناء تفعيل الهوية الموحّدة يتطلب مسار ربط الحسابات الفردي (B2).",
          },
          409,
        );
      }

      // Defensive fallback if substrate is ever non-ready during an admitted write:
      const created = await client.query<{
        id: number; username: string; display_name: string; role: string; is_active: boolean;
      }>(
        `INSERT INTO users (username, display_name, password_hash, role, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         RETURNING id, username, display_name, role, is_active`,
        [username, displayName, await hashPassword(password), source.role],
      );
      await insertAuditRow(client, {
        action: "user.create",
        entity: "user",
        entityId: created.rows[0].id,
        entityLabel: created.rows[0].username,
        details: { الدور: created.rows[0].role, الاسم: created.rows[0].display_name },
        actor: identity.username,
        actorRole: identity.role,
      });
      return usersJson({
        id: created.rows[0].id,
        username: created.rows[0].username,
        displayName: created.rows[0].display_name,
        role: created.rows[0].role,
        isActive: created.rows[0].is_active,
      }, 201);
    });
  } catch (error) {
    return mapCanonicalUsersRefusal(error, "تعذّر إنشاء المستخدم.");
  }
}

const CANONICAL_USER_PATCH_REASONS: Record<string, [number, string]> = {
  "self-staff-maintenance": [403, "لا يمكنك تعديل حسابك أنت من هنا (لا إيقاف ذاتي ولا تغيير دورك أو ربطك أو كلمة مرورك)."],
  "protected-owner": [403, "حساب المالك المحمي لا يُعدَّل من هنا."],
  "maintenance-denied": [403, "لا تملك صلاحية هذا التعديل على حسابات الطاقم."],
  "owner-operation-required": [403, "تغيير الدور أو ربط الطبيب أو تعيين كلمة مرور من صلاحيات المالك وحده."],
  "outside-delegable-authority": [403, "لا يمكنك إدارة حساب يملك صلاحيات أو نطاقًا لا تملكه أنت."],
  "stale-clinician-link": [409, "الحساب مربوط بطبيب غير نشط. أصلح الربط (أو أزله) قبل التفعيل."],
};

export async function canonicalUsersPatch(
  session: VerifiedDurableSession,
  request: Request,
  rawId: string,
): Promise<NextResponse> {
  if (process.env.USE_LOCAL_DB === "true" || usesSharedLocalDatabaseConnection()) {
    return usersJson({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
  }
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return usersJson({ message: "رقم المستخدم غير صالح." }, 400);
  }

  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return usersJson({ message: "طلب غير صالح." }, 400);
  }
  const source = (body ?? {}) as Record<string, unknown>;

  if (source.permissions !== undefined) {
    return usersJson(
      {
        code: "legacy_permissions_not_canonical",
        message: "صلاحيات الحساب الموحّد تُدار عبر محرّر الصلاحيات الموحّد (/api/staff-access) ولا تُكتب بالصيغة القديمة.",
      },
      409,
    );
  }

  const isLinkDoctorAction = source.action === "link_doctor";
  let requestedPartyId: number | null | undefined;
  let displayName: string | undefined;
  let role: string | undefined;
  let isActive: boolean | undefined;
  let passwordHash: string | undefined;
  let specialty: string | undefined;
  let branch: string | undefined;
  let commissionConfig: DoctorCommissionConfig | undefined;
  let clearCommissionConfig = false;

  if (isLinkDoctorAction) {
    const rawParty = Number(source.partyId);
    requestedPartyId = Number.isInteger(rawParty) && rawParty > 0 ? rawParty : null;
  } else {
    if (typeof source.displayName === "string") {
      const trimmed = source.displayName.trim();
      if (!trimmed || trimmed.length > 80) {
        return usersJson({ message: "الاسم الظاهر مطلوب (حتى 80 حرفًا)." }, 400);
      }
      displayName = trimmed;
    }
    if (source.role !== undefined) {
      if (!isRole(source.role)) return usersJson({ message: "دور غير معروف." }, 400);
      role = source.role;
    }
    if (typeof source.isActive === "boolean") {
      isActive = source.isActive;
    }
    if (typeof source.password === "string" && source.password.length > 0) {
      if (source.password.length < MIN_PASSWORD_LENGTH || source.password.length > MAX_PASSWORD_LENGTH) {
        return usersJson(
          { message: `كلمة المرور يجب أن تكون بين 8 و${MAX_PASSWORD_LENGTH} حرفًا.` },
          400,
        );
      }
      passwordHash = await hashPassword(source.password);
    }
    if (typeof source.specialty === "string") specialty = source.specialty.trim();
    if (typeof source.branch === "string") branch = source.branch.trim();
    if (source.commissionConfig === null) {
      clearCommissionConfig = true;
    } else if (source.commissionConfig !== undefined) {
      const checked = validateDoctorCommissionConfigInput(source.commissionConfig);
      if (!checked.ok) return usersJson({ message: checked.message }, 400);
      commissionConfig = checked.value;
    }

    if (
      displayName === undefined &&
      role === undefined &&
      isActive === undefined &&
      passwordHash === undefined &&
      specialty === undefined &&
      branch === undefined &&
      commissionConfig === undefined &&
      !clearCommissionConfig
    ) {
      return usersJson({ message: "لا يوجد ما يُحدَّث." }, 400);
    }
  }

  const commissionReason =
    typeof source.reason === "string" && source.reason.trim()
      ? source.reason.trim().slice(0, 300)
      : null;

  const s = staffIdentitySchemaName("public");
  try {
    return await withIsolation(getPool(), "READ COMMITTED", async (client) => {
      const xid = await canonicalUsersXid(client);
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [staffLifecycleLockKey(s)]);

      const actor = await loadExclusiveWriterAuthority(client, session, "staff.view", s);
      let target;
      try {
        target = await loadAdministrativeTargetState(client, id, s, "update");
      } catch (error) {
        if (error instanceof Error && /TARGET_/.test(error.message)) {
          return usersJson({ message: "المستخدم غير موجود." }, 404);
        }
        throw error;
      }

      const ops: StaffAccountOperation[] = [];
      if (isLinkDoctorAction) {
        ops.push("staff.clinician-link.change");
      } else {
        if (displayName !== undefined || specialty !== undefined || branch !== undefined) {
          ops.push("profile.edit");
        }
        if (isActive !== undefined) ops.push("accounts.disable");
        if (role !== undefined) ops.push("staff.role.change");
        if (passwordHash !== undefined) ops.push("staff.credentials.reset");
      }

      const touchesCommission = commissionConfig !== undefined || clearCommissionConfig;
      if (touchesCommission && !hasStaffCapability(actor.access, "finance.commissions.manage-rates")) {
        return usersJson({ message: "لا تملك صلاحية تعديل نسب العمولات." }, 403);
      }
      if (ops.length > 0) {
        const decision = validateStaffAccountChange(
          actor.access,
          { userId: target.user.id, ownerUserId: target.ownerUserId, isOwner: target.isOwner, document: target.document },
          ops,
        );
        if (!decision.ok) {
          const [status, message] = CANONICAL_USER_PATCH_REASONS[decision.reason] ?? [403, "لا تملك صلاحية هذا التعديل."];
          return usersJson({ message }, status);
        }
      } else if (touchesCommission && (target.isOwner && !actor.access.isOwner)) {
        return usersJson({ message: "حساب المالك المحمي لا يُعدَّل من هنا." }, 403);
      }

      const nextActive = isActive !== undefined ? isActive : target.user.isActive;
      const nextRole = role !== undefined ? role : target.user.role;
      if (target.user.role === "admin" && target.user.isActive && (!nextActive || nextRole !== "admin")) {
        const activeAdmins = await client.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM ${s}.users WHERE role = 'admin' AND is_active = TRUE`,
        );
        if ((activeAdmins.rows[0]?.n ?? 0) <= 1) {
          return usersJson(
            { message: "لا يمكن إيقاف آخر مدير أو تغيير دوره. عيّن مديرًا آخر أولًا." },
            409,
          );
        }
      }
      if (!isLinkDoctorAction && nextActive && target.provider === "stale") {
        const [status, message] = CANONICAL_USER_PATCH_REASONS["stale-clinician-link"];
        return usersJson({ message }, status);
      }

      const prevRowRes = await client.query<{ commission_config: string | null }>(
        `SELECT commission_config FROM ${s}.users WHERE id = $1`,
        [target.user.id],
      );
      const previousCommission = parseDoctorCommissionConfig(prevRowRes.rows[0]?.commission_config ?? null);

      const commissionCtx = {
        actor: actor.user.username,
        actorRole: actor.user.role,
        reason: isLinkDoctorAction ? "ربط حساب الطبيب بجهته" : commissionReason,
      };

      const executeUpdate = async (c: DbClient) => {
        if (isLinkDoctorAction) {
          if (requestedPartyId !== null && requestedPartyId !== undefined) {
            const { rows: [party] } = await c.query<{ kind: string; is_active: boolean }>(
              `SELECT kind, is_active FROM ${s}.parties WHERE id = $1`,
              [requestedPartyId],
            );
            if (!party || party.kind !== "doctor" || !party.is_active) {
              throw new StaffCapabilityEditError(400, "invalid-clinician", "الطبيب المختار غير موجود أو غير نشط.");
            }
          }
          const updated = await c.query<{ id: number }>(
            `UPDATE ${s}.users
                SET party_id = $2
              WHERE id = $1 AND authorization_mode = 'canonical' AND authorization_epoch::text = $3
              RETURNING id`,
            [target.user.id, requestedPartyId ?? null, target.user.authorizationEpoch],
          );
          if (updated.rowCount !== 1) {
            throw new StaffCapabilityEditError(409, "stale-version", "تغيّر هذا الحساب منذ فتحه. حدّث البيانات.");
          }
          return;
        }

        const nextCommissionJson = clearCommissionConfig
          ? null
          : commissionConfig !== undefined
            ? JSON.stringify(commissionConfig)
            : null;
        const updated = await c.query<{ id: number }>(
          `UPDATE ${s}.users SET
             display_name = CASE WHEN $2 THEN $3::text ELSE display_name END,
             role = CASE WHEN $4 THEN $5::text ELSE role END,
             is_active = CASE WHEN $6 THEN $7::boolean ELSE is_active END,
             password_hash = CASE WHEN $8 THEN $9::text ELSE password_hash END,
             specialty = CASE WHEN $10 THEN $11::text ELSE specialty END,
             branch = CASE WHEN $12 THEN $13::text ELSE branch END,
             commission_config = CASE WHEN $14 THEN $15::text ELSE commission_config END
           WHERE id = $1 AND authorization_mode = 'canonical' AND authorization_epoch::text = $16
           RETURNING id`,
          [
            target.user.id,
            displayName !== undefined, displayName ?? null,
            role !== undefined, role ?? null,
            isActive !== undefined, isActive ?? null,
            passwordHash !== undefined, passwordHash ?? null,
            specialty !== undefined, specialty ?? null,
            branch !== undefined, branch ?? null,
            touchesCommission, nextCommissionJson,
            target.user.authorizationEpoch,
          ],
        );
        if (updated.rowCount !== 1) {
          throw new StaffCapabilityEditError(409, "stale-version", "تغيّر هذا الحساب منذ فتحه. حدّث البيانات.");
        }
      };

      if (isLinkDoctorAction || touchesCommission) {
        const affectedParties = isLinkDoctorAction
          ? [target.user.partyId, requestedPartyId ?? null]
          : [target.user.partyId];
        const { changes: commissionChanges } = await doctorCommissionChangeOn(
          client,
          commissionCtx,
          "advanced",
          async () => affectedParties,
          executeUpdate,
        );
        for (const change of commissionChanges) {
          await insertAuditRow(client, doctorCommissionAuditInput(change, commissionCtx), s);
        }
      } else {
        await executeUpdate(client);
      }

      const { rows: [projectedRow] } = await client.query<CanonicalProjectedUserRow>(
        `SELECT u.id, u.username, u.display_name, u.role, u.is_active, u.created_at,
                CASE WHEN p.id IS NOT NULL THEN u.party_id ELSE NULL END AS party_id,
                p.name AS party_name,
                u.specialty, u.branch, u.commission_config, u.is_owner,
                sac.owner_user_id
           FROM ${s}.users u
           LEFT JOIN ${s}.parties p ON p.id = u.party_id AND p.kind = 'doctor' AND p.is_active
           LEFT JOIN ${s}.staff_authority_control sac ON sac.singleton = TRUE
          WHERE u.id = $1`,
        [target.user.id],
      );

      if (isLinkDoctorAction) {
        await insertAuditRow(client, {
          action: "user.update",
          entity: "user",
          entityId: target.user.id,
          entityLabel: projectedRow.username,
          details: { الربط: projectedRow.party_id ? `طبيب رقم ${projectedRow.party_id}` : "فكّ الربط" },
          actor: actor.user.username,
          actorRole: actor.user.role,
        }, s);
      } else {
        if (touchesCommission && !projectedRow.party_id) {
          await insertAuditRow(client, {
            action: "doctor.commission.update",
            entity: "user",
            entityId: target.user.id,
            entityLabel: projectedRow.username,
            details: {
              الطبيب: projectedRow.display_name,
              قبل_القيمة: previousCommission ?? null,
              بعد_القيمة: clearCommissionConfig ? null : commissionConfig,
              ملاحظة: "حسابٌ بلا جهة طبيب — لا أثر على العمولات حتى يُربط، ويسري من لحظة الربط",
              السبب: commissionReason,
            },
            actor: actor.user.username,
            actorRole: actor.user.role,
          }, s);
        }
        if (
          displayName !== undefined ||
          role !== undefined ||
          isActive !== undefined ||
          passwordHash !== undefined ||
          specialty !== undefined ||
          branch !== undefined
        ) {
          await insertAuditRow(client, {
            action: "user.update",
            entity: "user",
            entityId: target.user.id,
            entityLabel: projectedRow.username,
            details: {
              ...(displayName !== undefined ? { الاسم: projectedRow.display_name } : {}),
              ...(role !== undefined ? { الدور: projectedRow.role } : {}),
              ...(isActive !== undefined ? { الحالة: projectedRow.is_active ? "مفعّل" : "موقوف" } : {}),
              ...(passwordHash !== undefined ? { كلمة_المرور: "تغيير" } : {}),
              ...(specialty !== undefined ? { التخصص: projectedRow.specialty ?? "" } : {}),
              ...(branch !== undefined ? { الفرع: projectedRow.branch ?? "" } : {}),
            },
            actor: actor.user.username,
            actorRole: actor.user.role,
          }, s);
        }
      }

      const finalActor = await loadExclusiveWriterAuthority(client, session, "staff.view", s);
      if (await canonicalUsersXid(client) !== xid || !revalidateVerifiedDurableSession(session)) {
        throw new Error("STAFF_OPERATION_SESSION_EXPIRED");
      }

      const canSeeCommission =
        hasStaffCapability(finalActor.access, "finance.commissions.view-all") ||
        hasStaffCapability(finalActor.access, "finance.commissions.manage-rates");
      return usersJson(projectCanonicalUserRow(projectedRow, canSeeCommission), 200);
    });
  } catch (error) {
    if (error instanceof StaffCapabilityEditError) {
      return usersJson({ message: error.message }, error.status);
    }
    return mapCanonicalUsersRefusal(error, "تعذّر حفظ التعديل.");
  }
}

export async function canonicalAuthPasswordPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return usersJson({ message: "طلب غير صالح." }, 400);
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const currentPassword = typeof source.currentPassword === "string" ? source.currentPassword : "";
  const newPassword = typeof source.newPassword === "string" ? source.newPassword : "";

  if (!currentPassword) {
    return usersJson({ message: "اكتب كلمة المرور الحالية." }, 400);
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return usersJson({ message: `كلمة المرور الجديدة يجب ألا تقل عن ${MIN_PASSWORD_LENGTH} أحرف.` }, 400);
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return usersJson({ message: `كلمة المرور يجب ألا تتجاوز ${MAX_PASSWORD_LENGTH} حرفًا.` }, 400);
  }
  if (newPassword === currentPassword) {
    return usersJson({ message: "اختر كلمة مرور جديدة تختلف عن الحالية." }, 400);
  }

  try {
    const outcome = await changeCanonicalStaffOwnPassword({
      handle: session,
      currentPassword,
      newPassword,
    });
    if (outcome.kind !== "changed") {
      if (outcome.kind === "rate_limited") {
        return NextResponse.json(
          { message: "محاولات كثيرة. أعد المحاولة بعد ربع ساعة." },
          { status: 429, headers: { "Retry-After": String(outcome.retryAfterSeconds) } },
        );
      }
      if (outcome.kind === "wrong_password") {
        return usersJson({ message: "كلمة المرور الحالية غير صحيحة." }, 403);
      }
      if (outcome.kind === "invalid_input") {
        return usersJson({ message: outcome.error }, 400);
      }
      if (outcome.kind === "unavailable") {
        return usersJson({ message: "الهوية الموحّدة غير متاحة الآن." }, 503);
      }
      return usersJson({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
    }

    const response = NextResponse.json({ ok: true, message: "تغيّرت كلمة المرور. سُجّل خروج الأجهزة الأخرى." });
    response.cookies.set(SESSION_COOKIE, outcome.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: staffSessionCookieSecure(request.headers.get("host")),
      path: "/",
      maxAge: outcome.maxAgeSeconds,
    });
    return response;
  } catch {
    return usersJson({ message: "تعذّر تغيير كلمة المرور. أعد المحاولة." }, 500);
  }
}

export async function canonicalOpeningBalancesAccessGet(
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const admitted = await withCanonicalSelfSession(session, async (_client, view) => {
    const canManage = view.capabilities.includes("finance.opening-balances.manage");
    return { add: canManage, edit: canManage };
  });
  if (!admitted.ok) {
    return usersJson({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
  }
  return NextResponse.json(admitted.value, { headers: { "Cache-Control": "no-store" } });
}

export async function canonicalPrintLogPost(
  session: VerifiedDurableSession,
  request: Request,
): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return usersJson({ message: "طلب غير صالح." }, 400);
  }
  const source = (body ?? {}) as Record<string, unknown>;
  const docType = String(source.docType ?? "");
  const rawDocId = String(source.docId ?? "");

  try {
    const admitted = await withCanonicalSelfSession(session, async (client, view) => {
      if (!(PRINT_DOC_TYPES as readonly string[]).includes(docType) || !rawDocId) {
        return usersJson({ message: "مستند غير معروف." }, 400);
      }

      let docId = rawDocId;
      const caps = new Set(view.capabilities);

      if (docType === "prescription") {
        if (
          !caps.has("clinical.prescriptions.write") &&
          !caps.has("patients.operational-summary.view") &&
          !caps.has("clinical.visits.document")
        ) {
          return usersJson({ message: "لا تملك صلاحية طباعة الوصفات المحفوظة." }, 403);
        }
        const rxId = Number(docId);
        const patientId = Number(source.patientId);
        if (!Number.isSafeInteger(rxId) || rxId <= 0 || !Number.isSafeInteger(patientId) || patientId <= 0) {
          return usersJson({ message: "حدد الوصفة والمريض الصحيحين." }, 400);
        }
        const rxRes = await client.query<{ id: number; patient_id: number; status: string }>(
          `SELECT id, patient_id, status FROM prescriptions WHERE id = $1`,
          [rxId],
        );
        const rx = rxRes.rows[0];
        if (!rx || rx.patient_id !== patientId || rx.status !== "active") {
          return usersJson({ message: "الوصفة غير متاحة للطباعة أو ملغاة." }, 404);
        }
        if (view.patientScope === "none") {
          return usersJson({ message: "غير مصرح بالوصول إلى المريض." }, 403);
        }
        if (view.patientScope === "own") {
          if (!view.clinicianPartyId || !(await doctorOwnsPatient(view.clinicianPartyId, patientId, client))) {
            return usersJson({ message: "غير مصرح بالوصول إلى المريض." }, 403);
          }
        }
        docId = String(rx.id);
      } else if (docType === "card") {
        if (
          !caps.has("appointments.create") &&
          !caps.has("appointments.edit") &&
          view.appointmentScope === "none"
        ) {
          return usersJson({ message: "طباعة بطاقة الموعد للإدارة والاستقبال والطبيب." }, 403);
        }
      } else {
        const canPrintFinancial =
          caps.has("finance.payments.view") ||
          caps.has("finance.payments.collect") ||
          caps.has("finance.invoices.view") ||
          caps.has("finance.invoices.create") ||
          caps.has("finance.expenses.view") ||
          caps.has("finance.expenses.create") ||
          caps.has("finance.patient-ledger.view");
        if (!canPrintFinancial) {
          return usersJson({ message: "المستندات المالية للإدارة والاستقبال." }, 403);
        }
      }

      const prevRes = await client.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM document_prints WHERE doc_type = $1 AND doc_id = $2::text`,
        [docType, docId],
      );
      const previous = prevRes.rows[0]?.n ?? 0;
      await client.query(
        `INSERT INTO document_prints (doc_type, doc_id, printed_by) VALUES ($1, $2::text, $3)`,
        [docType, docId, view.username],
      );
      if (previous > 0) {
        await insertAuditRow(client, {
          action: "document.reprint",
          entity: docType,
          entityId: docId,
          details: { الطبعة_رقم: previous + 1 },
          actor: view.username,
          actorRole: view.roleLabel,
        });
      }
      return usersJson({ reprint: previous > 0, previous }, 200);
    });
    if (!admitted.ok) {
      return usersJson({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, 401);
    }
    return admitted.value;
  } catch {
    if (docType === "prescription") {
      return usersJson({ message: "تعذر تسجيل طباعة الوصفة؛ لم تُفتح نافذة الطباعة." }, 500);
    }
    return usersJson({ reprint: false, previous: 0 }, 200);
  }
}

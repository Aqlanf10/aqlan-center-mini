import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import type { AuditAction } from "./audit";
import { canonicalPatientReadFailure, NO_STORE } from "./canonical-patient-http";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import {
  broadcastMessagesWith,
  CLINIC_TIME_ZONE,
  deleteStaffMessageWith,
  directMessagesWith,
  doctorOwnedPatientIdsWith,
  doctorOwnsPatient,
  doctorOwnsPatientWith,
  editStaffMessageWith,
  getPatientWith,
  getPool,
  getStaffUserByIdWith,
  insertAuditRow,
  insertMessageWith,
  isVerifiedInboundReplyWith,
  listMessageDeliveriesWith,
  markConversationReadWith,
  messagingChannelWithSecretWith,
  patientIdsForOutboundRecipientWith,
  patientMessagingConsentWith,
  patientThreadMessagesWith,
  recordMessageDelivery,
  staffConversationListWith,
  unreadMessageCountWith,
  urgentUnreadMessageCountWith,
  type DbClient,
} from "./db";
import { readOperationalEmployment } from "./hr-operational-employment";
import type {
  ChecklistOperation,
  TaskListFilters,
  TaskListResult,
  UpdateTaskPatch,
} from "./hr";
import {
  isTaskLinkKind,
  isTaskPriority,
  TASK_LINK_KIND_LABEL,
  TASK_LINK_KINDS,
  TASK_PRIORITY_LABEL,
  TASK_STATUS_LABEL,
  taskToView,
  type HrStaffRow,
  type HrTaskRow,
  type HrTaskView,
  type TaskLinkKind,
  type TaskPriority,
  type TaskStatus,
} from "./hr-shared";
import { parseTaskDeadline } from "./hr-task-time";
import { bodyErrorResponse, readJsonBody } from "./http-body";
import {
  parseMessageId,
  parseMessageTarget,
  validateMessageEdit,
  validateOutgoingMessage,
} from "./messages";
import { isChannel } from "./messaging-channels";
import { sendOutbound } from "./messaging-send";
import { JSON_BODY_LIMIT_BYTES, MESSAGES_BODY_LIMIT_BYTES } from "./security-limits";
import type { StaffRecordConstraint } from "./staff-capabilities";
import type { VerifiedDurableSession } from "./staff-durable-session";
import {
  staffOperationCapabilities,
  staffOperationIdentity,
  staffOperationPatientScope,
  withStaffOperation,
} from "./staff-operation-runtime";

function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

function patientDocScopeFromConstraint(constraint: StaffRecordConstraint): number | null | undefined {
  if (constraint.kind === "all") return undefined;
  if (constraint.kind === "own") return constraint.clinicianPartyId;
  return null;
}

async function canAccessPatientInTx(
  client: DbClient,
  constraint: StaffRecordConstraint,
  patientId: number,
): Promise<boolean> {
  if (constraint.kind === "all") return true;
  if (constraint.kind === "own") {
    return doctorOwnsPatient(constraint.clinicianPartyId, patientId, client);
  }
  return false;
}

async function canAccessPatientInSnapshot(
  q: Pick<DbClient, "query">,
  constraint: StaffRecordConstraint,
  patientId: number,
): Promise<boolean> {
  if (constraint.kind === "all") return true;
  if (constraint.kind === "own") {
    return doctorOwnsPatientWith(q, constraint.clinicianPartyId, patientId);
  }
  return false;
}

/* ============================================================================
 * 1. INTERNAL STAFF & PORTAL-PATIENT MESSAGES (/api/messages)
 *    NOTE: POST, PATCH, DELETE are in AUDIT_EXEMPT — NEVER write audit_log!
 * ============================================================================ */

export async function messagesGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);

  try {
    if (url.searchParams.get("conversations") === "1") {
      const payload = await runCanonicalReadSnapshot(
        session,
        "messages.use",
        async (query, scope) => {
          const docScope = patientDocScopeFromConstraint(scope.patientScope);
          const list =
            docScope === undefined
              ? await staffConversationListWith(query, scope.userId)
              : await staffConversationListWith(query, scope.userId, docScope);
          const unread =
            docScope === undefined
              ? await unreadMessageCountWith(query, scope.userId)
              : await unreadMessageCountWith(query, scope.userId, docScope);
          const urgent =
            docScope === undefined
              ? await urgentUnreadMessageCountWith(query, scope.userId)
              : await urgentUnreadMessageCountWith(query, scope.userId, docScope);
          return {
            ...list,
            unread,
            urgent,
            meUserId: scope.userId,
            projection: {
              patientScope: scope.patientScope.kind,
            },
          };
        },
        { errorPrefix: "STAFF_READ", maxBytes: 4 * 1024 * 1024 },
      );
      return jsonNoStore(payload);
    }

    if (url.searchParams.get("unread") === "1") {
      const payload = await runCanonicalReadSnapshot(
        session,
        "messages.use",
        async (query, scope) => {
          const docScope = patientDocScopeFromConstraint(scope.patientScope);
          const unread =
            docScope === undefined
              ? await unreadMessageCountWith(query, scope.userId)
              : await unreadMessageCountWith(query, scope.userId, docScope);
          const urgent =
            docScope === undefined
              ? await urgentUnreadMessageCountWith(query, scope.userId)
              : await urgentUnreadMessageCountWith(query, scope.userId, docScope);
          return { unread, urgent };
        },
        { errorPrefix: "STAFF_READ", maxBytes: 64 * 1024 },
      );
      return jsonNoStore(payload);
    }

    const withUser = Number(url.searchParams.get("withUser"));
    const withPatient = Number(url.searchParams.get("withPatient"));
    const isBroadcast = url.searchParams.get("broadcast") === "1";

    if (!isBroadcast && !(Number.isInteger(withUser) && withUser > 0) && !(Number.isInteger(withPatient) && withPatient > 0)) {
      await runCanonicalReadSnapshot(
        session,
        "messages.use",
        async () => ({ ok: true }),
        { errorPrefix: "STAFF_READ", maxBytes: 1024 },
      );
      return jsonNoStore({ message: "حدّد المحادثة المطلوبة." }, 400);
    }

    const outcome = await withStaffOperation(
      getPool(),
      session,
      "messages.use",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "messages.use");
        if (isBroadcast) {
          const messages = await broadcastMessagesWith(client);
          await markConversationReadWith(client, identity.userId, { broadcast: true });
          return { status: 200, body: { messages } };
        }
        if (Number.isInteger(withUser) && withUser > 0) {
          const messages = await directMessagesWith(client, identity.userId, withUser);
          await markConversationReadWith(client, identity.userId, { withUserId: withUser });
          return { status: 200, body: { messages } };
        }
        const patientScope = await staffOperationPatientScope(client, handle, "messages.use");
        if (!(await canAccessPatientInTx(client, patientScope, withPatient))) {
          return {
            status: 403,
            body: { message: "غير مصرّح لك بالاطلاع على محادثات هذا المريض." },
          };
        }
        const messages = await patientThreadMessagesWith(client, withPatient);
        await markConversationReadWith(client, identity.userId, { withPatientId: withPatient });
        return { status: 200, body: { messages } };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    return canonicalPatientReadFailure(error, "تعذّر تحميل المحادثة.");
  }
}

export async function messagesPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "messages.use",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "messages.use");
        let body: unknown;
        try {
          body = await readJsonBody(request, MESSAGES_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;
        const target = parseMessageTarget(source.to);
        if (!target) {
          return { status: 400, body: { message: "جهة الرسالة غير صالحة." } };
        }
        const verdict = validateOutgoingMessage(target, source);
        if (!verdict.ok) {
          return { status: 400, body: { message: verdict.message } };
        }
        const message = verdict.value;

        if (target.type === "user") {
          const recipient = await getStaffUserByIdWith(client, target.id!);
          if (!recipient || !recipient.isActive) {
            return { status: 404, body: { message: "الزميل غير موجود أو غير مفعّل." } };
          }
        } else if (target.type === "patient") {
          const patient = await getPatientWith(client, target.id!);
          if (!patient) {
            return { status: 404, body: { message: "ملف المريض غير موجود." } };
          }
          const patientScope = await staffOperationPatientScope(client, handle, "messages.use");
          if (!(await canAccessPatientInTx(client, patientScope, target.id!))) {
            return { status: 403, body: { message: "غير مصرّح لك بمراسلة هذا المريض." } };
          }
        } else if (target.type === "staff_all") {
          return {
            status: 400,
            body: { message: "المرسل من الطاقم يخاطب زميلًا أو مريضًا — صندوق المرضى للبوابة." },
          };
        }

        try {
          const created = await insertMessageWith(client, {
            senderType: "user",
            senderUserId: identity.userId,
            senderPatientId: null,
            recipientType: target.type === "staff_broadcast" ? "staff_all" : target.type,
            recipientUserId: target.type === "user" ? target.id! : null,
            recipientPatientId: target.type === "patient" ? target.id! : null,
            body: message.body,
            kind: message.kind,
            voiceMime: message.voiceMime,
            voiceData: message.voiceData,
            voiceMs: message.voiceMs,
            fileName: message.fileName,
            fileMime: message.fileMime,
            fileSize: message.fileSize,
            fileData: message.fileData,
            replyToId: message.replyToId,
          });
          return { status: 201, body: created };
        } catch (error) {
          if (error instanceof Error && error.message === "reply-out-of-thread") {
            return {
              status: 400,
              body: { message: "لا يُردّ إلا على رسالة من المحادثة نفسها." },
            };
          }
          throw error;
        }
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر إرسال الرسالة.");
  }
}

export async function messagesPatchCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "messages.use",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "messages.use");
        let body: unknown;
        try {
          body = await readJsonBody(request, MESSAGES_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const verdict = validateMessageEdit((body ?? {}) as Record<string, unknown>);
        if (!verdict.ok) {
          return { status: 400, body: { message: verdict.message } };
        }
        const result = await editStaffMessageWith(
          client,
          verdict.value.messageId,
          identity.userId,
          verdict.value.body,
        );
        if (!result.ok) {
          return {
            status: 403,
            body: { message: "لا يمكن تعديل هذه الرسالة — النصية غير المحذوفة لك وحدك." },
          };
        }
        return { status: 200, body: result.message };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر تعديل الرسالة.");
  }
}

export async function messagesDeleteCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "messages.use",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "messages.use");
        const url = new URL(request.url);
        let id = parseMessageId(url.searchParams.get("id"));
        if (id === null) {
          try {
            const body = await readJsonBody<Record<string, unknown>>(request, JSON_BODY_LIMIT_BYTES);
            id = parseMessageId(body?.id);
          } catch (error) {
            const bounded = bodyErrorResponse(error);
            if (bounded) throw error;
            id = null;
          }
        }
        if (id === null) {
          return { status: 400, body: { message: "رسالة غير صالحة." } };
        }
        const result = await deleteStaffMessageWith(client, id, identity.userId);
        if (!result.ok) {
          return {
            status: 403,
            body: { message: "لا يمكن حذف هذه الرسالة — رسائلك المرسلة وحدك." },
          };
        }
        return { status: 200, body: result.message };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر حذف الرسالة.");
  }
}

/* ============================================================================
 * 2. OUTBOUND PATIENT MESSAGING (/api/messages/outbound)
 * ============================================================================ */

export async function messagesOutboundGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const rawPatientId = Number(params.get("patientId"));
  const patientId = Number.isInteger(rawPatientId) && rawPatientId > 0 ? rawPatientId : null;
  const rawChannel = params.get("channel");
  const channel = isChannel(rawChannel) ? rawChannel : null;

  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "messages.use",
      async (query, scope) => {
        if (patientId !== null) {
          if (!(await canAccessPatientInSnapshot(query, scope.patientScope, patientId))) {
            return {
              kind: "forbidden" as const,
              message: "غير مصرّح لك بالاطلاع على سجل رسائل هذا المريض.",
            };
          }
        }
        const allRows = await listMessageDeliveriesWith(query, {
          patientId,
          channel,
          limit: 200,
        });
        if (scope.patientScope.kind === "all") {
          return { kind: "ok" as const, rows: allRows };
        }
        if (scope.patientScope.kind === "none") {
          return {
            kind: "ok" as const,
            rows: allRows.filter((row) => row.patientId === null),
          };
        }
        const candidateIds = [
          ...new Set(
            allRows
              .map((row) => row.patientId)
              .filter((id): id is number => typeof id === "number" && id > 0),
          ),
        ];
        const owned = await doctorOwnedPatientIdsWith(
          query,
          scope.patientScope.clinicianPartyId,
          candidateIds,
        );
        return {
          kind: "ok" as const,
          rows: allRows.filter((row) => row.patientId !== null && owned.has(row.patientId)),
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 4 * 1024 * 1024 },
    );
    if (payload.kind === "forbidden") {
      return jsonNoStore({ message: payload.message }, 403);
    }
    return jsonNoStore({ rows: payload.rows });
  } catch (error) {
    return canonicalPatientReadFailure(error, "تعذّر تحميل سجل الرسائل.");
  }
}

export async function messagesOutboundPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    // Phase 1: Canonical admission + validation + DB preflight without holding DB locks across external network I/O.
    const preflight = await withStaffOperation(
      getPool(),
      session,
      "messages.use",
      async (client, handle) => {
        const identity = await staffOperationIdentity(client, handle, "messages.use");
        let body: Record<string, unknown>;
        try {
          const raw = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
          body = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { kind: "early" as const, status: 400, body: { message: "طلب غير صالح." } };
        }

        if (!isChannel(body.channel)) {
          return {
            kind: "early" as const,
            status: 400,
            body: { message: "اختر القناة: واتساب أو رسالة نصية أو بريد." },
          };
        }
        const channel = body.channel;
        const patientId = Number(body.patientId);
        let patient =
          Number.isInteger(patientId) && patientId > 0
            ? await getPatientWith(client, patientId)
            : null;
        if (body.patientId !== undefined && body.patientId !== null && !patient) {
          return { kind: "early" as const, status: 404, body: { message: "المريض غير موجود." } };
        }

        const typed = typeof body.to === "string" ? body.to.trim().slice(0, 200) : "";
        const to = typed || (channel !== "email" ? patient?.phone ?? "" : patient?.email ?? "");
        if (!to) {
          return {
            kind: "early" as const,
            status: 400,
            body: {
              message:
                channel === "email"
                  ? "لا بريد لهذا المريض — أدخل بريد المستلم."
                  : "لا رقم جوال لهذا المريض — أدخل الرقم.",
            },
          };
        }

        const matchingPatients = await patientIdsForOutboundRecipientWith(client, channel, to);
        if (patient && matchingPatients.length > 0 && !matchingPatients.includes(patient.id)) {
          return {
            kind: "early" as const,
            status: 409,
            body: { message: "وسيلة التواصل تخص مريضًا آخر؛ اختر ملف المستلم الصحيح." },
          };
        }
        if (!patient && matchingPatients.length > 1) {
          return {
            kind: "early" as const,
            status: 409,
            body: { message: "وسيلة التواصل مشتركة بين مرضى؛ اختر ملف المريض قبل الإرسال." },
          };
        }
        if (!patient && matchingPatients.length === 1) {
          patient = await getPatientWith(client, matchingPatients[0]);
        }

        if (patient) {
          const patientScope = await staffOperationPatientScope(client, handle, "messages.use");
          if (!(await canAccessPatientInTx(client, patientScope, patient.id))) {
            return {
              kind: "early" as const,
              status: 403,
              body: { message: "غير مصرّح لك بمراسلة هذا المريض." },
            };
          }
        }

        const channelData = await messagingChannelWithSecretWith(client, channel);
        const purpose = body.purpose === "reply" ? ("reply" as const) : ("manual" as const);
        const replyToInboundId =
          typeof body.replyToInboundId === "number" ? body.replyToInboundId : null;
        const consentData =
          patient && purpose === "manual"
            ? await patientMessagingConsentWith(client, patient.id, channel)
            : null;
        const replyVerified =
          purpose === "reply" &&
          replyToInboundId !== null &&
          Number.isInteger(replyToInboundId) &&
          replyToInboundId > 0
            ? await isVerifiedInboundReplyWith(client, {
                inboundId: replyToInboundId,
                channel,
                patientId: patient?.id ?? null,
                to,
              })
            : false;

        return {
          kind: "ready" as const,
          actor: identity.username,
          actorRole: identity.role,
          channel,
          to,
          subject: typeof body.subject === "string" ? body.subject.slice(0, 200) : null,
          textBody: typeof body.body === "string" ? body.body : "",
          patientId: patient?.id ?? null,
          patientName: patient?.fullName ?? null,
          purpose,
          replyToInboundId,
          channelData,
          consentData,
          replyVerified,
        };
      },
    );

    if (preflight.kind === "early") {
      return jsonNoStore(preflight.body, preflight.status);
    }

    // Phase 2: Execute sendOutbound outside DB transaction, then record audit atomically.
    const result = await sendOutbound(
      {
        channel: preflight.channel,
        to: preflight.to,
        subject: preflight.subject,
        body: preflight.textBody,
        patientId: preflight.patientId,
        purpose: preflight.purpose,
        actor: preflight.actor,
        replyToInboundId: preflight.replyToInboundId,
      },
      {
        channel: async () => ({
          view: preflight.channelData.view,
          secret: preflight.channelData.secret,
        }),
        record: recordMessageDelivery,
        consent: preflight.consentData ? async () => preflight.consentData! : undefined,
        verifyReply: async () => preflight.replyVerified,
      },
    );

    await insertAuditRow(getPool(), {
      action: "messaging.send",
      entity: preflight.patientId !== null ? "patient" : "message_delivery",
      entityId: preflight.patientId ?? result.deliveryId,
      entityLabel: preflight.patientName ?? preflight.channel,
      details: { channel: preflight.channel, ok: result.ok },
      actor: preflight.actor,
      actorRole: preflight.actorRole,
    }).catch(() => undefined);

    return result.ok
      ? jsonNoStore(
          {
            ok: true,
            deliveryId: result.deliveryId,
            ...(result.logged
              ? {}
              : { message: "أُرسلت الرسالة، لكن تعذّر حفظها في السجل — لا تُعد إرسالها." }),
          },
          201,
        )
      : jsonNoStore(
          { ok: false, message: result.message, deliveryId: result.deliveryId },
          result.status,
        );
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر إرسال الرسالة.");
  }
}

/* ============================================================================
 * 3. TASKS (/api/tasks, /api/tasks/[id], checklist, comments, links)
 * ============================================================================ */

interface CanonicalTaskActor {
  readonly userId: number;
  readonly username: string;
  readonly role: string;
  readonly oversight: boolean;
  readonly patientScope: StaffRecordConstraint;
  readonly canViewLab: boolean;
  readonly canViewInventory: boolean;
}

function taskRowMapper(row: Record<string, unknown>): HrTaskRow {
  return row as unknown as HrTaskRow;
}

function staffRowMapper(row: Record<string, unknown>): HrStaffRow {
  return row as unknown as HrStaffRow;
}

function canSeeCanonicalTask(
  task: Pick<HrTaskRow, "is_private" | "owner_user_id" | "assignee_staff_id">,
  actor: Pick<CanonicalTaskActor, "userId" | "oversight">,
  viewerStaffId: number | null,
): boolean {
  if (task.is_private) return task.owner_user_id === actor.userId;
  if (actor.oversight) return true;
  if (task.owner_user_id === actor.userId) return true;
  return (
    viewerStaffId !== null &&
    task.assignee_staff_id !== null &&
    task.assignee_staff_id === viewerStaffId
  );
}

function canManageCanonicalTask(
  task: Pick<HrTaskRow, "is_private" | "owner_user_id">,
  actor: Pick<CanonicalTaskActor, "userId" | "oversight">,
): boolean {
  if (task.is_private) return task.owner_user_id === actor.userId;
  if (actor.oversight) return true;
  return task.owner_user_id === actor.userId;
}

function canWorkOnCanonicalTask(
  task: Pick<HrTaskRow, "is_private" | "owner_user_id" | "assignee_staff_id">,
  actor: Pick<CanonicalTaskActor, "userId" | "oversight">,
  viewerStaffId: number | null,
): boolean {
  if (canManageCanonicalTask(task, actor)) return true;
  if (task.is_private) return false;
  return (
    viewerStaffId !== null &&
    task.assignee_staff_id !== null &&
    task.assignee_staff_id === viewerStaffId
  );
}

async function staffIdForUserWith(q: Pick<DbClient, "query">, userId: number): Promise<number | null> {
  const result = await q.query(`SELECT id FROM hr_staff WHERE user_id = $1`, [userId]);
  return result.rowCount && result.rowCount > 0 ? Number(result.rows[0].id) : null;
}

async function userDisplayNameWith(
  q: Pick<DbClient, "query">,
  userId: number,
  fallbackUsername: string,
): Promise<string> {
  const result = await q.query(`SELECT display_name FROM users WHERE id = $1`, [userId]);
  return result.rowCount && result.rowCount > 0
    ? String(result.rows[0].display_name)
    : fallbackUsername;
}

async function recordTaskEventWith(
  client: DbClient,
  input: {
    taskId: number;
    actorUserId: number;
    actorDisplayName: string;
    action: "create" | "update" | "status" | "assign" | "comment" | "checklist" | "visibility" | "link" | "unlink";
    field?: string | null;
    oldValue?: string | null;
    newValue?: string | null;
    linkId?: number | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO hr_task_events (task_id, actor_user_id, actor_display_name, action, field, old_value, new_value, link_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.taskId,
      input.actorUserId,
      input.actorDisplayName,
      input.action,
      input.field ?? null,
      input.oldValue ?? null,
      input.newValue ?? null,
      input.linkId ?? null,
    ],
  );
}

async function linkReadableInSnapshot(
  q: Pick<DbClient, "query">,
  actor: CanonicalTaskActor,
  kind: TaskLinkKind,
  linkId: number,
): Promise<boolean> {
  if (kind === "patient") {
    const exists = await q.query(`SELECT 1 FROM patients WHERE id = $1`, [linkId]);
    if (!exists.rowCount) return false;
    return canAccessPatientInSnapshot(q, actor.patientScope, linkId);
  }
  if (kind === "lab_order") {
    if (!actor.canViewLab) return false;
    const order = await q.query<{ patient_id: number }>(
      `SELECT patient_id FROM lab_orders WHERE id = $1`,
      [linkId],
    );
    if (!order.rowCount) return false;
    return canAccessPatientInSnapshot(q, actor.patientScope, Number(order.rows[0].patient_id));
  }
  if (!actor.canViewInventory) return false;
  const exists = await q.query(`SELECT 1 FROM inventory_items WHERE id = $1`, [linkId]);
  return Boolean(exists.rowCount);
}

async function linkReadableInTx(
  client: DbClient,
  actor: CanonicalTaskActor,
  kind: TaskLinkKind,
  linkId: number,
): Promise<boolean> {
  if (kind === "patient") {
    const exists = await client.query(`SELECT 1 FROM patients WHERE id = $1`, [linkId]);
    if (!exists.rowCount) return false;
    return canAccessPatientInTx(client, actor.patientScope, linkId);
  }
  if (kind === "lab_order") {
    if (!actor.canViewLab) return false;
    const order = await client.query<{ patient_id: number }>(
      `SELECT patient_id FROM lab_orders WHERE id = $1`,
      [linkId],
    );
    if (!order.rowCount) return false;
    return canAccessPatientInTx(client, actor.patientScope, Number(order.rows[0].patient_id));
  }
  if (!actor.canViewInventory) return false;
  const exists = await client.query(`SELECT 1 FROM inventory_items WHERE id = $1`, [linkId]);
  return Boolean(exists.rowCount);
}

async function describeLinkTargetWith(
  q: Pick<DbClient, "query">,
  kind: TaskLinkKind,
  linkId: number,
): Promise<string | null> {
  if (kind === "patient") {
    const result = await q.query(`SELECT patient_number, full_name FROM patients WHERE id = $1`, [linkId]);
    if (!result.rowCount) return null;
    return `${result.rows[0].patient_number} — ${result.rows[0].full_name}`;
  }
  if (kind === "lab_order") {
    const result = await q.query(
      `SELECT l.work_type, p.full_name AS patient FROM lab_orders l JOIN patients p ON p.id = l.patient_id WHERE l.id = $1`,
      [linkId],
    );
    if (!result.rowCount) return null;
    return `${result.rows[0].work_type} — ${result.rows[0].patient}`;
  }
  const result = await q.query(`SELECT name FROM inventory_items WHERE id = $1`, [linkId]);
  if (!result.rowCount) return null;
  return String(result.rows[0].name);
}

async function loadCanonicalTaskActorInTx(
  client: DbClient,
  handle: Parameters<typeof staffOperationIdentity>[1],
): Promise<CanonicalTaskActor> {
  const identity = await staffOperationIdentity(client, handle, "tasks.use");
  const caps = await staffOperationCapabilities(client, handle, "tasks.use", [
    "hr.directory.view",
    "clinical.lab.view",
    "inventory.references.view",
  ]);
  const patientScope = await staffOperationPatientScope(client, handle, "tasks.use");
  return {
    userId: identity.userId,
    username: identity.username,
    role: identity.role,
    oversight: caps.has("hr.directory.view"),
    patientScope,
    canViewLab: caps.has("clinical.lab.view"),
    canViewInventory: caps.has("inventory.references.view"),
  };
}

const TASK_CREATE_FINGERPRINT = "task-create-sha256-v1:";
const TASK_STATUS_EVENT: Record<TaskStatus, string> = {
  planned: "أعادتها إلى مخططة",
  in_progress: "بدأها",
  blocked: "أوقفها — متعطلة",
  completed: "أكملها",
  cancelled: "ألغاها",
};

export async function tasksGetCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const priority = url.searchParams.get("priority");
  const filters: TaskListFilters = {
    status:
      status && ["planned", "in_progress", "blocked", "completed", "cancelled"].includes(status)
        ? (status as TaskListFilters["status"])
        : null,
    priority:
      priority && ["low", "normal", "high", "urgent"].includes(priority)
        ? (priority as TaskListFilters["priority"])
        : null,
    search: url.searchParams.get("q")?.slice(0, 120) ?? null,
    overdueOnly: url.searchParams.get("overdue") === "1",
    assigneeStaffId: (() => {
      const raw = url.searchParams.get("assigneeStaffId");
      const parsed = Number(raw);
      return raw && Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    })(),
    scope: url.searchParams.get("scope") === "team" ? "team" : "mine",
  };

  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "tasks.use",
      async (query, scope): Promise<TaskListResult & { timeZone: string }> => {
        const viewerStaffId = await staffIdForUserWith(query, scope.userId);
        const oversight = scope.granted("hr.directory.view");
        const params: unknown[] = [scope.userId];
        const visibility: string[] = [`(t.is_private AND t.owner_user_id = $1)`];
        if (oversight) {
          visibility.push(`(NOT t.is_private)`);
        } else {
          visibility.push(`(NOT t.is_private AND t.owner_user_id = $1)`);
        }
        if (viewerStaffId !== null) {
          params.push(viewerStaffId);
          visibility.push(`(NOT t.is_private AND t.assignee_staff_id = $${params.length})`);
        }
        let mineOnly: string | null = null;
        if (filters.scope === "mine") {
          const mine = [`t.owner_user_id = $1`];
          if (viewerStaffId !== null) mine.push(`t.assignee_staff_id = $${params.length}`);
          mineOnly = `(${mine.join(" OR ")})`;
        }

        const conditions: string[] = [`(${visibility.join(" OR ")})`];
        if (mineOnly) conditions.push(mineOnly);
        if (filters.status) {
          params.push(filters.status);
          conditions.push(`t.status = $${params.length}`);
        }
        if (filters.priority) {
          params.push(filters.priority);
          conditions.push(`t.priority = $${params.length}`);
        }
        if (filters.assigneeStaffId) {
          params.push(filters.assigneeStaffId);
          conditions.push(`t.assignee_staff_id = $${params.length}`);
        }
        if (filters.overdueOnly) {
          conditions.push(
            `t.due_at IS NOT NULL AND t.due_at < NOW() AND t.status IN ('planned','in_progress','blocked')`,
          );
        }
        if (filters.search && filters.search.trim()) {
          params.push(`%${filters.search.trim()}%`);
          conditions.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
        }

        const where = `WHERE ${conditions.join(" AND ")}`;
        const rows = await query.query(
          `SELECT t.* FROM hr_tasks t ${where} ORDER BY t.updated_at DESC LIMIT 300`,
          params,
        );
        const countResult = await query.query(
          `SELECT t.status, COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE t.due_at IS NOT NULL AND t.due_at < NOW()
               AND t.status IN ('planned','in_progress','blocked'))::int AS overdue
           FROM hr_tasks t ${where} GROUP BY t.status`,
          params,
        );
        const counts: Record<TaskStatus, number> = {
          planned: 0,
          in_progress: 0,
          blocked: 0,
          completed: 0,
          cancelled: 0,
        };
        let overdueCount = 0;
        for (const row of countResult.rows) {
          const st = String(row.status) as TaskStatus;
          if (st in counts) counts[st] = Number(row.n);
          overdueCount += Number(row.overdue);
        }
        const nowMs = Date.now();
        return {
          tasks: rows.rows.map((row) => taskToView(taskRowMapper(row), nowMs)),
          counts,
          overdueCount,
          timeZone: CLINIC_TIME_ZONE,
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 4 * 1024 * 1024 },
    );
    return jsonNoStore(payload);
  } catch (error) {
    return canonicalPatientReadFailure(error, "تعذّر تحميل المهام.");
  }
}

export async function tasksPostCanonicalResponse(
  request: Request,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "tasks.use",
      async (client, handle) => {
        const actor = await loadCanonicalTaskActorInTx(client, handle);

        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;
        if (source.expectedOwner !== undefined) {
          const expected = source.expectedOwner as { username?: unknown; role?: unknown } | null;
          if (!expected || expected.username !== actor.username || expected.role !== actor.role) {
            return {
              status: 403,
              body: { message: "تغيّر صاحب الجلسة؛ لم يُنفّذ طلب الإنشاء المحفوظ." },
            };
          }
        }

        const title = typeof source.title === "string" ? source.title.trim() : "";
        if (!title || title.length > 200) {
          return { status: 400, body: { message: "اكتب عنوان المهمة (إلى 200 حرف)." } };
        }
        const description =
          typeof source.description === "string" ? source.description.trim().slice(0, 4000) : "";
        const isPrivate = source.isPrivate === true;
        const priorityInput = source.priority ?? "normal";
        if (!isTaskPriority(priorityInput)) {
          return {
            status: 400,
            body: { message: "الأولوية: منخفضة أو عادية أو عالية أو عاجلة." },
          };
        }
        let dueAt: string | null = null;
        if (source.dueAt !== undefined && source.dueAt !== null && source.dueAt !== "") {
          try {
            dueAt = parseTaskDeadline(source.dueAt, CLINIC_TIME_ZONE);
          } catch {
            return {
              status: 400,
              body: { message: "موعد الاستحقاق بتوقيت العيادة أو بإزاحة زمنية صريحة." },
            };
          }
        }
        let plannedFor: string | null = null;
        if (source.plannedFor !== undefined && source.plannedFor !== null && source.plannedFor !== "") {
          const raw = String(source.plannedFor);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
            return { status: 400, body: { message: "تاريخ التخطيط بصيغة YYYY-MM-DD." } };
          }
          plannedFor = raw;
        }
        const clientRequestId =
          source.clientRequestId === undefined || source.clientRequestId === null
            ? null
            : typeof source.clientRequestId === "string"
              ? source.clientRequestId.trim()
              : "";
        if (clientRequestId !== null && (clientRequestId.length < 8 || clientRequestId.length > 100)) {
          return { status: 400, body: { message: "مفتاح طلب الإنشاء غير صالح." } };
        }
        const rawAssignee = Number(source.assigneeStaffId);
        const assigneeStaffId =
          source.assigneeStaffId !== undefined &&
          source.assigneeStaffId !== null &&
          Number.isInteger(rawAssignee) &&
          rawAssignee > 0
            ? rawAssignee
            : null;
        if (isPrivate && assigneeStaffId !== null) {
          return {
            status: 400,
            body: { message: "المهمة الخاصة لك وحدك — أزل الإسناد أو اجعلها مشتركة." },
          };
        }

        const refusal = (status: number, error: string) => ({
          status,
          body: {
            message: error,
            ...([400, 401, 403, 404].includes(status)
              ? {
                  creationRefusal: {
                    clientRequestId,
                    username: actor.username,
                    role: actor.role,
                    noWrite: true,
                  },
                }
              : {}),
          },
        });

        if (!isPrivate && assigneeStaffId !== null && !actor.oversight) {
          return refusal(
            403,
            "إسناد المهام للإدارة المخولة (دليل الطاقم) — أنشئ المهمة بلا مسؤولٍ وستتابعها الإدارة.",
          );
        }

        const canonical = {
          title,
          description,
          isPrivate,
          priority: priorityInput as TaskPriority,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
          plannedFor,
          assigneeStaffId,
        };
        const fingerprint =
          TASK_CREATE_FINGERPRINT +
          createHash("sha256").update(JSON.stringify(canonical)).digest("hex");

        if (clientRequestId !== null) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `hr-task-create:${clientRequestId}`,
          ]);
          const existing = await client.query(
            "SELECT * FROM hr_tasks WHERE client_request_id = $1 FOR UPDATE",
            [clientRequestId],
          );
          if (existing.rows[0]) {
            const row = taskRowMapper(existing.rows[0]);
            const viewerStaffId = await staffIdForUserWith(client, actor.userId);
            if (
              row.owner_user_id !== actor.userId ||
              !canSeeCanonicalTask(row, actor, viewerStaffId)
            ) {
              return refusal(
                409,
                "تعذّر تأكيد طلب الإنشاء بهذا المفتاح. راجع مهامك قبل إنشاء طلب آخر.",
              );
            }
            const evidence = await client.query(
              "SELECT old_value FROM hr_task_events WHERE task_id = $1 AND action = 'create' AND actor_user_id = $2 ORDER BY id LIMIT 1",
              [row.id, actor.userId],
            );
            if (evidence.rows[0]?.old_value !== fingerprint) {
              return refusal(
                409,
                "تعذّر تأكيد طلب الإنشاء بهذا المفتاح. راجع مهامك قبل إنشاء طلب آخر.",
              );
            }
            return {
              status: 201,
              body: {
                ...taskToView(row),
                creationReceipt: {
                  clientRequestId,
                  username: actor.username,
                  role: actor.role,
                },
              },
            };
          }
        }

        let resolvedStaffId: number | null = null;
        let resolvedUserId: number | null = null;
        let assigneeLabel = "";
        if (!canonical.isPrivate && canonical.assigneeStaffId !== null) {
          const staff = await client.query(
            "SELECT id, full_name, user_id, work_status FROM hr_staff WHERE id = $1 FOR SHARE",
            [canonical.assigneeStaffId],
          );
          if (!staff.rows[0]) {
            return refusal(404, "ملف الموظف المسند إليه غير موجود.");
          }
          const emp = await readOperationalEmployment(client, [Number(staff.rows[0].id)]);
          if (emp.forStaff(staffRowMapper(staff.rows[0])).status !== "active") {
            return refusal(
              400,
              "لا تُسند مهمة لموظف غير نشط أو حالته المؤرخة غير معروفة؛ راجع تاريخ العمل.",
            );
          }
          resolvedStaffId = Number(staff.rows[0].id);
          resolvedUserId = staff.rows[0].user_id === null ? null : Number(staff.rows[0].user_id);
          assigneeLabel = String(staff.rows[0].full_name);
        }

        const displayName = await userDisplayNameWith(client, actor.userId, actor.username);
        const inserted = await client.query(
          `INSERT INTO hr_tasks
             (title, description, is_private, status, priority, due_at, planned_for, owner_user_id, owner_display_name,
              assignee_staff_id, assignee_user_id, assignee_label, created_by, client_request_id)
           VALUES ($1, $2, $3, 'planned', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
           RETURNING *`,
          [
            canonical.title,
            canonical.description,
            canonical.isPrivate,
            canonical.priority,
            canonical.dueAt,
            canonical.plannedFor,
            actor.userId,
            displayName,
            resolvedStaffId,
            resolvedUserId,
            assigneeLabel,
            actor.username,
            clientRequestId,
          ],
        );
        if (!inserted.rows[0]) {
          return refusal(
            409,
            "تعذّر تأكيد طلب الإنشاء بهذا المفتاح. راجع مهامك قبل إنشاء طلب آخر.",
          );
        }
        const row = taskRowMapper(inserted.rows[0]);
        await recordTaskEventWith(client, {
          taskId: row.id,
          actorUserId: actor.userId,
          actorDisplayName: displayName,
          action: "create",
          field: canonical.isPrivate ? "is_private" : null,
          oldValue: clientRequestId === null ? null : fingerprint,
          newValue: canonical.isPrivate ? "خاصة" : assigneeLabel || null,
        });
        await insertAuditRow(client, {
          action: "task.create",
          entity: "hr_task",
          entityId: String(row.id),
          entityLabel: canonical.isPrivate
            ? "إنشاء مهمة خاصة"
            : `إنشاء مهمة مسندة إلى ${assigneeLabel || "لا أحد"}`,
          details: { private: canonical.isPrivate },
          actor: actor.username,
          actorRole: actor.role,
        });
        return {
          status: 201,
          body: {
            ...taskToView(row),
            creationReceipt: {
              clientRequestId,
              username: actor.username,
              role: actor.role,
            },
          },
        };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر إنشاء المهمة.");
  }
}

export async function taskDetailGetCanonicalResponse(
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const taskId = Number(rawId);
  try {
    const payload = await runCanonicalReadSnapshot(
      session,
      "tasks.use",
      async (query, scope) => {
        if (!Number.isInteger(taskId) || taskId <= 0) {
          return { kind: "bad_request" as const };
        }
        const result = await query.query(`SELECT * FROM hr_tasks WHERE id = $1`, [taskId]);
        if (!result.rowCount || result.rowCount === 0) {
          return { kind: "not_found" as const };
        }
        const row = taskRowMapper(result.rows[0]);
        const actor: CanonicalTaskActor = {
          userId: scope.userId,
          username: scope.username,
          role: scope.role,
          oversight: scope.granted("hr.directory.view"),
          patientScope: scope.patientScope,
          canViewLab: scope.granted("clinical.lab.view"),
          canViewInventory: scope.granted("inventory.references.view"),
        };
        const viewerStaffId = await staffIdForUserWith(query, scope.userId);
        if (!canSeeCanonicalTask(row, actor, viewerStaffId)) {
          return { kind: "not_found" as const };
        }

        const checklistResult = await query.query(
          `SELECT id, label, done, done_by, done_at FROM hr_task_checklist WHERE task_id = $1 ORDER BY position, id`,
          [taskId],
        );
        const commentsResult = await query.query(
          `SELECT id, author_user_id, author_display_name, body, created_at FROM hr_task_comments WHERE task_id = $1 ORDER BY id`,
          [taskId],
        );
        const eventsResult = await query.query(
          `SELECT id, actor_user_id, actor_display_name, action, field, old_value, new_value, link_id, created_at
           FROM hr_task_events WHERE task_id = $1 ORDER BY id DESC LIMIT 200`,
          [taskId],
        );
        const linksResult = await query.query(
          `SELECT id, link_kind, link_id, link_label FROM hr_task_links WHERE task_id = $1 ORDER BY id`,
          [taskId],
        );

        const links: {
          id: number;
          kind: TaskLinkKind;
          linkId: number;
          label: string;
          readable: boolean;
        }[] = [];
        for (const link of linksResult.rows) {
          const kind = String(link.link_kind) as TaskLinkKind;
          const linkId = Number(link.link_id);
          const readable = await linkReadableInSnapshot(query, actor, kind, linkId);
          links.push({
            id: Number(link.id),
            kind,
            linkId,
            label: readable ? String(link.link_label) : "",
            readable,
          });
        }

        const events: {
          id: number;
          actorUserId: number;
          actorDisplayName: string;
          action: string;
          field: string | null;
          oldValue: string | null;
          newValue: string | null;
          createdAt: string;
        }[] = [];
        for (const event of eventsResult.rows) {
          const action = String(event.action);
          const field = event.field ? String(event.field) : null;
          let oldValue = event.old_value ? String(event.old_value) : null;
          let newValue = event.new_value ? String(event.new_value) : null;
          if (action === "create" && oldValue?.startsWith(TASK_CREATE_FINGERPRINT)) {
            oldValue = null;
          }
          if ((action === "link" || action === "unlink") && field !== null) {
            const kind = field as TaskLinkKind;
            const linkId =
              event.link_id === null || event.link_id === undefined
                ? null
                : Number(event.link_id);
            const readable =
              linkId !== null &&
              (TASK_LINK_KINDS as readonly string[]).includes(kind) &&
              (await linkReadableInSnapshot(query, actor, kind, linkId));
            if (!readable) {
              oldValue = null;
              newValue = null;
            }
          }
          events.push({
            id: Number(event.id),
            actorUserId: Number(event.actor_user_id),
            actorDisplayName: String(event.actor_display_name),
            action,
            field,
            oldValue,
            newValue,
            createdAt: new Date(event.created_at).toISOString(),
          });
        }

        return {
          kind: "ok" as const,
          detail: {
            task: taskToView(row),
            checklist: checklistResult.rows.map((item) => ({
              id: Number(item.id),
              label: String(item.label),
              done: Boolean(item.done),
              doneBy: item.done_by ? String(item.done_by) : null,
              doneAt: item.done_at ? new Date(item.done_at).toISOString() : null,
            })),
            comments: commentsResult.rows.map((comment) => ({
              id: Number(comment.id),
              authorUserId: Number(comment.author_user_id),
              authorDisplayName: String(comment.author_display_name),
              body: String(comment.body),
              createdAt: new Date(comment.created_at).toISOString(),
            })),
            events,
            links,
            permissions: {
              canManage: canManageCanonicalTask(row, actor),
              canWork: canWorkOnCanonicalTask(row, actor, viewerStaffId),
            },
          },
        };
      },
      { errorPrefix: "STAFF_READ", maxBytes: 4 * 1024 * 1024 },
    );
    if (payload.kind === "bad_request") {
      return jsonNoStore({ message: "رقم المهمة غير صالح." }, 400);
    }
    if (payload.kind === "not_found") {
      return jsonNoStore({ message: "المهمة غير موجودة أو غير مرئية لك." }, 404);
    }
    return jsonNoStore(payload.detail);
  } catch (error) {
    return canonicalPatientReadFailure(error, "تعذّر تحميل المهمة.");
  }
}

export async function taskDetailPatchCanonicalResponse(
  request: Request,
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const taskId = Number(rawId);
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "tasks.use",
      async (client, handle) => {
        const actor = await loadCanonicalTaskActorInTx(client, handle);
        if (!Number.isInteger(taskId) || taskId <= 0) {
          return { status: 400, body: { message: "رقم المهمة غير صالح." } };
        }

        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;
        const patch: UpdateTaskPatch = {};
        if (source.title !== undefined) {
          const title = typeof source.title === "string" ? source.title.trim() : "";
          if (!title || title.length > 200) {
            return { status: 400, body: { message: "العنوان نصٌّ من 1 إلى 200 حرف." } };
          }
          patch.title = title;
        }
        if (source.description !== undefined) {
          if (typeof source.description !== "string" || source.description.length > 4000) {
            return { status: 400, body: { message: "الوصف نصٌّ حتى 4000 حرف." } };
          }
          patch.description = source.description.trim();
        }
        if (source.priority !== undefined) {
          if (!isTaskPriority(source.priority)) {
            return {
              status: 400,
              body: { message: "الأولوية: منخفضة أو عادية أو عالية أو عاجلة." },
            };
          }
          patch.priority = source.priority;
        }
        if (source.dueAt !== undefined) {
          if (source.dueAt === null || source.dueAt === "") {
            patch.dueAt = null;
          } else {
            try {
              patch.dueAt = parseTaskDeadline(source.dueAt, CLINIC_TIME_ZONE);
            } catch {
              return {
                status: 400,
                body: { message: "موعد الاستحقاق بتوقيت العيادة أو بإزاحة زمنية صريحة." },
              };
            }
          }
        }
        if (source.plannedFor !== undefined) {
          if (source.plannedFor === null || source.plannedFor === "") {
            patch.plannedFor = null;
          } else if (
            typeof source.plannedFor === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(source.plannedFor)
          ) {
            patch.plannedFor = source.plannedFor;
          } else {
            return { status: 400, body: { message: "تاريخ التخطيط بصيغة YYYY-MM-DD." } };
          }
        }
        if (source.status !== undefined) {
          if (
            typeof source.status !== "string" ||
            !["planned", "in_progress", "blocked", "completed", "cancelled"].includes(source.status)
          ) {
            return {
              status: 400,
              body: { message: "الحالة: مخططة أو جارية أو متعطلة أو مكتملة أو ملغاة." },
            };
          }
          patch.status = source.status as UpdateTaskPatch["status"];
        }
        if (source.assigneeStaffId !== undefined) {
          if (source.assigneeStaffId === null) {
            patch.assigneeStaffId = null;
          } else {
            const parsed = Number(source.assigneeStaffId);
            if (!Number.isInteger(parsed) || parsed <= 0) {
              return { status: 400, body: { message: "المسؤول موظفٌ من ملفات الطاقم." } };
            }
            patch.assigneeStaffId = parsed;
          }
        }
        if (source.convertToShared === true) patch.convertToShared = true;
        if (typeof source.expectedUpdatedAt === "string" && source.expectedUpdatedAt) {
          patch.expectedUpdatedAt = source.expectedUpdatedAt;
        }

        const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [
          taskId,
        ]);
        if (!current.rows[0]) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        const row = taskRowMapper(current.rows[0]);
        const viewerStaffId = await staffIdForUserWith(client, actor.userId);
        if (!canSeeCanonicalTask(row, actor, viewerStaffId)) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }

        const managementChangeRequested =
          patch.title !== undefined ||
          patch.description !== undefined ||
          patch.priority !== undefined ||
          patch.dueAt !== undefined ||
          patch.plannedFor !== undefined ||
          patch.assigneeStaffId !== undefined ||
          patch.convertToShared === true;

        if (managementChangeRequested && !canManageCanonicalTask(row, actor)) {
          return {
            status: 403,
            body: {
              message:
                "تعديل عنوان المهمة أو وصفها أو أولويتها أو موعديها أو مسؤولها أو مشاركتها يتطلب صلاحية إدارة المهمة — المكلّف يغيّر الحالة ويعلّق ويعمل في القائمة.",
            },
          };
        }
        if (patch.expectedUpdatedAt !== undefined) {
          const expected = new Date(patch.expectedUpdatedAt).getTime();
          if (!Number.isFinite(expected) || expected !== new Date(row.updated_at).getTime()) {
            return {
              status: 409,
              body: {
                message: "غُيِّرت المهمة من جلسة أخرى بعد فتحك لها — أعد التحميل ثم أعد المحاولة.",
              },
            };
          }
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        const events: {
          action: "update" | "status" | "assign" | "visibility";
          field: string;
          oldValue: string | null;
          newValue: string | null;
        }[] = [];

        if (patch.convertToShared === true && row.is_private) {
          sets.push(`is_private = FALSE`);
          events.push({
            action: "visibility",
            field: "is_private",
            oldValue: "خاصة",
            newValue: "مشتركة",
          });
        }
        if (patch.title !== undefined && patch.title !== row.title) {
          params.push(patch.title);
          sets.push(`title = $${params.length}`);
          events.push({
            action: "update",
            field: "title",
            oldValue: row.title,
            newValue: patch.title,
          });
        }
        if (patch.description !== undefined && patch.description !== row.description) {
          params.push(patch.description);
          sets.push(`description = $${params.length}`);
          events.push({ action: "update", field: "description", oldValue: null, newValue: null });
        }
        if (patch.priority !== undefined && patch.priority !== row.priority) {
          params.push(patch.priority);
          sets.push(`priority = $${params.length}`);
          events.push({
            action: "update",
            field: "priority",
            oldValue: TASK_PRIORITY_LABEL[row.priority],
            newValue: TASK_PRIORITY_LABEL[patch.priority],
          });
        }
        if (
          patch.dueAt !== undefined &&
          (patch.dueAt ?? null) !== (row.due_at ? new Date(row.due_at).toISOString() : null)
        ) {
          params.push(patch.dueAt);
          sets.push(`due_at = $${params.length}`);
          events.push({
            action: "update",
            field: "due_at",
            oldValue: row.due_at ? new Date(row.due_at).toISOString() : null,
            newValue: patch.dueAt,
          });
        }
        if (
          patch.plannedFor !== undefined &&
          (patch.plannedFor ?? null) !==
            (row.planned_for ? String(row.planned_for).slice(0, 10) : null)
        ) {
          params.push(patch.plannedFor);
          sets.push(`planned_for = $${params.length}`);
          events.push({
            action: "update",
            field: "planned_for",
            oldValue: row.planned_for ? String(row.planned_for).slice(0, 10) : null,
            newValue: patch.plannedFor,
          });
        }
        if (patch.assigneeStaffId !== undefined && patch.assigneeStaffId !== row.assignee_staff_id) {
          if (row.is_private && patch.convertToShared !== true) {
            return { status: 400, body: { message: "المهمة الخاصة لا تقبل إسنادًا." } };
          }
          if (patch.assigneeStaffId === null) {
            sets.push(`assignee_staff_id = NULL, assignee_user_id = NULL, assignee_label = ''`);
            events.push({
              action: "assign",
              field: "assignee",
              oldValue: row.assignee_label || null,
              newValue: null,
            });
          } else {
            if (!actor.oversight) {
              return {
                status: 403,
                body: { message: "إسناد المهام يتطلب صلاحية دليل الطاقم." },
              };
            }
            const staff = await client.query(
              `SELECT id, full_name, user_id, work_status FROM hr_staff WHERE id = $1 FOR SHARE`,
              [patch.assigneeStaffId],
            );
            if (!staff.rowCount) {
              return { status: 404, body: { message: "ملف الموظف المسند إليه غير موجود." } };
            }
            const emp = await readOperationalEmployment(client, [Number(staff.rows[0].id)]);
            if (emp.forStaff(staffRowMapper(staff.rows[0])).status !== "active") {
              return {
                status: 400,
                body: {
                  message:
                    "لا تُسند مهمة لموظف غير نشط أو حالته المؤرخة غير معروفة؛ راجع تاريخ العمل.",
                },
              };
            }
            params.push(
              Number(staff.rows[0].id),
              staff.rows[0].user_id === null ? null : Number(staff.rows[0].user_id),
              String(staff.rows[0].full_name),
            );
            sets.push(
              `assignee_staff_id = $${params.length - 2}, assignee_user_id = $${params.length - 1}, assignee_label = $${params.length}`,
            );
            events.push({
              action: "assign",
              field: "assignee",
              oldValue: row.assignee_label || null,
              newValue: String(staff.rows[0].full_name),
            });
          }
        }
        if (patch.status !== undefined && patch.status !== row.status) {
          if (!canWorkOnCanonicalTask(row, actor, viewerStaffId)) {
            return { status: 403, body: { message: "لا تعمل في هذه المهمة." } };
          }
          params.push(patch.status);
          sets.push(`status = $${params.length}`);
          if (patch.status === "completed") {
            sets.push(`completed_at = NOW()`);
          } else if (row.status === "completed") {
            sets.push(`completed_at = NULL`);
          }
          events.push({
            action: "status",
            field: "status",
            oldValue: TASK_STATUS_LABEL[row.status],
            newValue: TASK_STATUS_LABEL[patch.status],
          });
        }

        if (sets.length === 0) {
          return { status: 200, body: taskToView(row) };
        }

        const displayName = await userDisplayNameWith(client, actor.userId, actor.username);
        params.push(taskId);
        sets.push(`updated_at = NOW()`);
        const updated = await client.query(
          `UPDATE hr_tasks SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`,
          params,
        );
        const updatedRow = taskRowMapper(updated.rows[0]);
        for (const event of events) {
          await recordTaskEventWith(client, {
            taskId,
            actorUserId: actor.userId,
            actorDisplayName: displayName,
            action: event.action,
            field: event.field,
            oldValue: event.oldValue,
            newValue: event.newValue,
          });
        }

        const primary = events[0];
        if (primary) {
          const auditAction: AuditAction =
            primary.action === "status"
              ? "task.status"
              : primary.action === "assign"
                ? "task.assign"
                : primary.action === "visibility"
                  ? "task.visibility"
                  : "task.update";
          const auditLabel =
            primary.action === "visibility"
              ? "تحويل مهمة خاصة إلى مشتركة"
              : primary.action === "status"
                ? `${TASK_STATUS_EVENT[patch.status ?? "planned"]} (#${taskId})`
                : `تعديل مهمة (#${taskId})`;
          await insertAuditRow(client, {
            action: auditAction,
            entity: "hr_task",
            entityId: String(taskId),
            entityLabel: auditLabel,
            details: { fields: events.map((e) => e.field), private: row.is_private },
            actor: actor.username,
            actorRole: actor.role,
          });
        }
        return { status: 200, body: taskToView(updatedRow) };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر تحديث المهمة.");
  }
}

export async function taskChecklistPostCanonicalResponse(
  request: Request,
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const taskId = Number(rawId);
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "tasks.use",
      async (client, handle) => {
        const actor = await loadCanonicalTaskActorInTx(client, handle);
        if (!Number.isInteger(taskId) || taskId <= 0) {
          return { status: 400, body: { message: "رقم المهمة غير صالح." } };
        }
        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;
        const clientRequestId =
          typeof source.clientRequestId === "string" && source.clientRequestId.trim().length >= 8
            ? source.clientRequestId.trim().slice(0, 100)
            : null;
        let operation: ChecklistOperation;
        if (source.op === "add") {
          const label = typeof source.label === "string" ? source.label.trim() : "";
          if (!label || label.length > 300) {
            return { status: 400, body: { message: "بند التحقق نصٌّ من 1 إلى 300 حرف." } };
          }
          operation = { op: "add", label, clientRequestId };
        } else if (source.op === "toggle") {
          const itemId = Number(source.itemId);
          if (!Number.isInteger(itemId) || itemId <= 0) {
            return { status: 400, body: { message: "بند التحقق غير صالح." } };
          }
          operation = { op: "toggle", itemId, done: source.done === true };
        } else if (source.op === "remove") {
          const itemId = Number(source.itemId);
          if (!Number.isInteger(itemId) || itemId <= 0) {
            return { status: 400, body: { message: "بند التحقق غير صالح." } };
          }
          operation = { op: "remove", itemId };
        } else {
          return {
            status: 400,
            body: { message: "عملية قائمة التحقق: إضافة أو تحويل أو إزالة." },
          };
        }

        const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [
          taskId,
        ]);
        if (!current.rows[0]) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        const row = taskRowMapper(current.rows[0]);
        const viewerStaffId = await staffIdForUserWith(client, actor.userId);
        if (!canSeeCanonicalTask(row, actor, viewerStaffId)) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        if (!canWorkOnCanonicalTask(row, actor, viewerStaffId)) {
          return { status: 403, body: { message: "لا تعمل في هذه المهمة." } };
        }

        const displayName = await userDisplayNameWith(client, actor.userId, actor.username);
        let auditSummary: string | null = null;
        if (operation.op === "add") {
          const insertResult = operation.clientRequestId
            ? await client.query(
                `INSERT INTO hr_task_checklist (task_id, label, position, client_request_id)
                 SELECT $1, $2, COALESCE(MAX(position), 0) + 1, $3 FROM hr_task_checklist WHERE task_id = $1
                 ON CONFLICT (task_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
                 RETURNING id`,
                [taskId, operation.label, operation.clientRequestId],
              )
            : await client.query(
                `INSERT INTO hr_task_checklist (task_id, label, position)
                 SELECT $1, $2, COALESCE(MAX(position), 0) + 1 FROM hr_task_checklist WHERE task_id = $1
                 RETURNING id`,
                [taskId, operation.label],
              );
          if (insertResult.rows.length === 0) {
            return { status: 200, body: { ok: true } };
          }
          await recordTaskEventWith(client, {
            taskId,
            actorUserId: actor.userId,
            actorDisplayName: displayName,
            action: "checklist",
            field: "add",
            newValue: operation.label,
          });
          auditSummary = `إضافة بند تحقق (#${taskId})`;
        } else if (operation.op === "toggle") {
          const item = await client.query(
            `SELECT id, label, done FROM hr_task_checklist WHERE id = $1 AND task_id = $2 FOR UPDATE`,
            [operation.itemId, taskId],
          );
          if (!item.rowCount) {
            return { status: 404, body: { message: "بند التحقق غير موجود." } };
          }
          await client.query(
            `UPDATE hr_task_checklist SET done = $1, done_by = $2, done_at = $3 WHERE id = $4`,
            [
              operation.done,
              operation.done ? displayName : null,
              operation.done ? new Date() : null,
              operation.itemId,
            ],
          );
          await recordTaskEventWith(client, {
            taskId,
            actorUserId: actor.userId,
            actorDisplayName: displayName,
            action: "checklist",
            field: operation.done ? "done" : "undone",
            newValue: String(item.rows[0].label),
          });
          auditSummary = `تحديث بند تحقق (#${taskId})`;
        } else {
          const item = await client.query(
            `SELECT id, label FROM hr_task_checklist WHERE id = $1 AND task_id = $2`,
            [operation.itemId, taskId],
          );
          if (!item.rowCount) {
            return { status: 404, body: { message: "بند التحقق غير موجود." } };
          }
          await client.query(`DELETE FROM hr_task_checklist WHERE id = $1`, [operation.itemId]);
          await recordTaskEventWith(client, {
            taskId,
            actorUserId: actor.userId,
            actorDisplayName: displayName,
            action: "checklist",
            field: "remove",
            oldValue: String(item.rows[0].label),
          });
          auditSummary = `حذف بند تحقق (#${taskId})`;
        }

        await client.query(`UPDATE hr_tasks SET updated_at = NOW() WHERE id = $1`, [taskId]);
        if (auditSummary !== null) {
          await insertAuditRow(client, {
            action: "task.checklist",
            entity: "hr_task",
            entityId: String(taskId),
            entityLabel: auditSummary,
            details: { private: row.is_private },
            actor: actor.username,
            actorRole: actor.role,
          });
        }
        return { status: 200, body: { ok: true } };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر تحديث قائمة التحقق.");
  }
}

export async function taskCommentsPostCanonicalResponse(
  request: Request,
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const taskId = Number(rawId);
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "tasks.use",
      async (client, handle) => {
        const actor = await loadCanonicalTaskActorInTx(client, handle);
        if (!Number.isInteger(taskId) || taskId <= 0) {
          return { status: 400, body: { message: "رقم المهمة غير صالح." } };
        }
        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;
        const commentBody = typeof source.body === "string" ? source.body.trim() : "";
        if (!commentBody || commentBody.length > 2000) {
          return { status: 400, body: { message: "اكتب التعليق (من 1 إلى 2000 حرف)." } };
        }
        const clientRequestId =
          typeof source.clientRequestId === "string" && source.clientRequestId.trim().length >= 8
            ? source.clientRequestId.trim().slice(0, 100)
            : null;

        const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [
          taskId,
        ]);
        if (!current.rows[0]) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        const row = taskRowMapper(current.rows[0]);
        const viewerStaffId = await staffIdForUserWith(client, actor.userId);
        if (!canSeeCanonicalTask(row, actor, viewerStaffId)) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        if (!canWorkOnCanonicalTask(row, actor, viewerStaffId)) {
          return { status: 403, body: { message: "لا تعمل في هذه المهمة." } };
        }

        const displayName = await userDisplayNameWith(client, actor.userId, actor.username);
        const result = clientRequestId
          ? await client.query(
              `INSERT INTO hr_task_comments (task_id, author_user_id, author_display_name, body, client_request_id)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (task_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING
               RETURNING id, created_at`,
              [taskId, actor.userId, displayName, commentBody, clientRequestId],
            )
          : await client.query(
              `INSERT INTO hr_task_comments (task_id, author_user_id, author_display_name, body)
               VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
              [taskId, actor.userId, displayName, commentBody],
            );

        if (result.rows.length === 0) {
          const existing = await client.query(
            `SELECT id, created_at FROM hr_task_comments WHERE task_id = $1 AND client_request_id = $2`,
            [taskId, clientRequestId],
          );
          if (existing.rows.length > 0) {
            return {
              status: 201,
              body: {
                id: Number(existing.rows[0].id),
                createdAt: new Date(existing.rows[0].created_at).toISOString(),
              },
            };
          }
          return { status: 500, body: { message: "تعذّر إضافة التعليق — أعد المحاولة." } };
        }

        await client.query(`UPDATE hr_tasks SET updated_at = NOW() WHERE id = $1`, [taskId]);
        await recordTaskEventWith(client, {
          taskId,
          actorUserId: actor.userId,
          actorDisplayName: displayName,
          action: "comment",
        });
        await insertAuditRow(client, {
          action: "task.comment",
          entity: "hr_task",
          entityId: String(taskId),
          entityLabel: `تعليق على مهمة (#${taskId})`,
          details: { private: row.is_private },
          actor: actor.username,
          actorRole: actor.role,
        });
        return {
          status: 201,
          body: {
            id: Number(result.rows[0].id),
            createdAt: new Date(result.rows[0].created_at).toISOString(),
          },
        };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر إضافة التعليق.");
  }
}

export async function taskLinksPostCanonicalResponse(
  request: Request,
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const taskId = Number(rawId);
  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "tasks.use",
      async (client, handle) => {
        const actor = await loadCanonicalTaskActorInTx(client, handle);
        if (!Number.isInteger(taskId) || taskId <= 0) {
          return { status: 400, body: { message: "رقم المهمة غير صالح." } };
        }
        let body: unknown;
        try {
          body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES);
        } catch (error) {
          const bounded = bodyErrorResponse(error);
          if (bounded) throw error;
          return { status: 400, body: { message: "طلب غير صالح." } };
        }
        const source = (body ?? {}) as Record<string, unknown>;
        if (!isTaskLinkKind(source.linkKind)) {
          return {
            status: 400,
            body: { message: "نوع الرابط: مريض أو أمر مختبر أو بند مخزون." },
          };
        }
        const linkId = Number(source.linkId);
        if (!Number.isInteger(linkId) || linkId <= 0) {
          return { status: 400, body: { message: "معرّف السجل المربوط غير صالح." } };
        }
        const kind = source.linkKind;

        const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [
          taskId,
        ]);
        if (!current.rows[0]) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        const row = taskRowMapper(current.rows[0]);
        const viewerStaffId = await staffIdForUserWith(client, actor.userId);
        if (!canSeeCanonicalTask(row, actor, viewerStaffId)) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        if (!canManageCanonicalTask(row, actor)) {
          return { status: 403, body: { message: "لا تدير هذه المهمة." } };
        }
        if (!(await linkReadableInTx(client, actor, kind, linkId))) {
          return {
            status: 404,
            body: {
              message: "السجل المطلوب ربطه غير موجود أو خارج صلاحياتك — الربط لا يمنح وصولًا.",
            },
          };
        }
        const label = await describeLinkTargetWith(client, kind, linkId);
        if (label === null) {
          return { status: 404, body: { message: "السجل المطلوب ربطه غير موجود." } };
        }
        const duplicate = await client.query(
          `SELECT 1 FROM hr_task_links WHERE task_id = $1 AND link_kind = $2 AND link_id = $3`,
          [taskId, kind, linkId],
        );
        if (duplicate.rowCount) {
          return { status: 409, body: { message: "السجل مرتبط بهذه المهمة مسبقًا." } };
        }

        const displayName = await userDisplayNameWith(client, actor.userId, actor.username);
        await client.query(
          `INSERT INTO hr_task_links (task_id, link_kind, link_id, link_label, linked_by) VALUES ($1, $2, $3, $4, $5)`,
          [taskId, kind, linkId, label, actor.username],
        );
        await client.query(`UPDATE hr_tasks SET updated_at = NOW() WHERE id = $1`, [taskId]);
        await recordTaskEventWith(client, {
          taskId,
          actorUserId: actor.userId,
          actorDisplayName: displayName,
          action: "link",
          field: kind,
          newValue: label,
          linkId,
        });
        await insertAuditRow(client, {
          action: "task.link",
          entity: "hr_task",
          entityId: String(taskId),
          entityLabel: `ربط مهمة (#${taskId}) بـ${TASK_LINK_KIND_LABEL[kind]}`,
          details: { kind, linkId, private: row.is_private },
          actor: actor.username,
          actorRole: actor.role,
        });
        return { status: 201, body: { label } };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    const bounded = bodyErrorResponse(error);
    if (bounded) return bounded;
    return canonicalPatientReadFailure(error, "تعذّر إنشاء الرابط.");
  }
}

export async function taskLinksDeleteCanonicalResponse(
  request: Request,
  rawId: string,
  session: VerifiedDurableSession,
): Promise<NextResponse> {
  const taskId = Number(rawId);
  const url = new URL(request.url);
  const linkId = Number(url.searchParams.get("linkId"));

  try {
    const outcome = await withStaffOperation(
      getPool(),
      session,
      "tasks.use",
      async (client, handle) => {
        const actor = await loadCanonicalTaskActorInTx(client, handle);
        if (!Number.isInteger(taskId) || taskId <= 0) {
          return { status: 400, body: { message: "رقم المهمة غير صالح." } };
        }
        if (!Number.isInteger(linkId) || linkId <= 0) {
          return { status: 400, body: { message: "معرّف الرابط غير صالح." } };
        }
        const current = await client.query(`SELECT * FROM hr_tasks WHERE id = $1 FOR UPDATE`, [
          taskId,
        ]);
        if (!current.rows[0]) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        const row = taskRowMapper(current.rows[0]);
        const viewerStaffId = await staffIdForUserWith(client, actor.userId);
        if (!canSeeCanonicalTask(row, actor, viewerStaffId)) {
          return { status: 404, body: { message: "المهمة غير موجودة أو غير مرئية لك." } };
        }
        if (!canManageCanonicalTask(row, actor)) {
          return { status: 403, body: { message: "لا تدير هذه المهمة." } };
        }
        const link = await client.query(
          `SELECT id, link_kind, link_id, link_label FROM hr_task_links WHERE id = $1 AND task_id = $2`,
          [linkId, taskId],
        );
        if (!link.rowCount) {
          return { status: 404, body: { message: "الرابط غير موجود." } };
        }
        const displayName = await userDisplayNameWith(client, actor.userId, actor.username);
        await client.query(`DELETE FROM hr_task_links WHERE id = $1`, [linkId]);
        await client.query(`UPDATE hr_tasks SET updated_at = NOW() WHERE id = $1`, [taskId]);
        const kind = String(link.rows[0].link_kind);
        await recordTaskEventWith(client, {
          taskId,
          actorUserId: actor.userId,
          actorDisplayName: displayName,
          action: "unlink",
          field: kind,
          oldValue: String(link.rows[0].link_label),
          linkId: Number(link.rows[0].link_id),
        });
        await insertAuditRow(client, {
          action: "task.unlink",
          entity: "hr_task",
          entityId: String(taskId),
          entityLabel: `فكّ ربط مهمة (#${taskId}) عن ${kind}`,
          details: { private: row.is_private },
          actor: actor.username,
          actorRole: actor.role,
        });
        return { status: 200, body: { ok: true } };
      },
    );
    return jsonNoStore(outcome.body, outcome.status);
  } catch (error) {
    return canonicalPatientReadFailure(error, "تعذّر فكّ الرابط.");
  }
}

import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  canUseTasks, createTask, isTaskPriority, listTasks, type TaskListFilters, type HrTaskWriteAuthorizer,
} from "@/lib/hr";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const denied = () =>
  NextResponse.json({ message: "انتهت الجلسة. سجّل الدخول من جديد." }, { status: 401 });

/** قائمة المهام كما يراها سائلها — الخصوصية تُبنى في WHERE على الخادم. */
export async function GET(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canUseTasks(session.role)) {
    return NextResponse.json({ message: "المهام خارج صلاحيات دورك." }, { status: 403 });
  }
  const url = new URL(request.url);
  const status = url.searchParams.get("status");
  const priority = url.searchParams.get("priority");
  const filters: TaskListFilters = {
    status: status && ["planned", "in_progress", "blocked", "completed", "cancelled"].includes(status)
      ? (status as TaskListFilters["status"]) : null,
    priority: priority && ["low", "normal", "high", "urgent"].includes(priority)
      ? (priority as TaskListFilters["priority"]) : null,
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
    return NextResponse.json(await listTasks(session, filters));
  } catch {
    return NextResponse.json({ message: "تعذّر تحميل المهام." }, { status: 500 });
  }
}

/** إنشاء مهمة خاصة أو مشتركة مسندة — الخاصة لا تقبل مسؤولًا أصلًا. */
export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return denied();
  if (!canUseTasks(session.role)) {
    return NextResponse.json({ message: "المهام خارج صلاحيات دورك." }, { status: 403 });
  }

  let body: unknown;
  try { body = await readJsonBody(request, JSON_BODY_LIMIT_BYTES); } catch (error) { const bounded = bodyErrorResponse(error); if (bounded) return bounded;
    return NextResponse.json({ message: "طلب غير صالح." }, { status: 400 });
  }
  const source = (body ?? {}) as Record<string, unknown>;
  // Client owner is a fence, never authority. A changed signed session cannot
  // submit another owner's retained draft after switching accounts.
  if (source.expectedOwner !== undefined) {
    const expected = source.expectedOwner as { username?: unknown; role?: unknown } | null;
    if (!expected || expected.username !== session.username || expected.role !== session.role) {
      return NextResponse.json({ message: "تغيّر صاحب الجلسة؛ لم يُنفّذ طلب الإنشاء المحفوظ." }, { status: 403 });
    }
  }

  const title = typeof source.title === "string" ? source.title.trim() : "";
  if (!title || title.length > 200) {
    return NextResponse.json({ message: "اكتب عنوان المهمة (إلى 200 حرف)." }, { status: 400 });
  }
  const description = typeof source.description === "string" ? source.description.trim().slice(0, 4000) : "";
  const isPrivate = source.isPrivate === true;
  const priorityInput = source.priority ?? "normal";
  if (!isTaskPriority(priorityInput)) {
    return NextResponse.json({ message: "الأولوية: منخفضة أو عادية أو عالية أو عاجلة." }, { status: 400 });
  }
  let dueAt: string | null = null;
  if (source.dueAt !== undefined && source.dueAt !== null && source.dueAt !== "") {
    const parsed = new Date(String(source.dueAt));
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ message: "موعد الاستحقاق تاريخٌ صالح." }, { status: 400 });
    }
    dueAt = parsed.toISOString();
  }
  // تاريخ التخطيط: يومٌ مستقل عن الاستحقاق — حالة «مخطّطة» وحدها لا تعوّضه.
  let plannedFor: string | null = null;
  if (source.plannedFor !== undefined && source.plannedFor !== null && source.plannedFor !== "") {
    const raw = String(source.plannedFor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return NextResponse.json({ message: "تاريخ التخطيط بصيغة YYYY-MM-DD." }, { status: 400 });
    }
    plannedFor = raw;
  }
  // مفتاح معاملة العميل لمنع تكرار الإنشاء عند فقدان الرد — طولٌ معقول ومضبوط.
  const clientRequestId = source.clientRequestId === undefined || source.clientRequestId === null
    ? null : typeof source.clientRequestId === "string" ? source.clientRequestId.trim() : "";
  if (clientRequestId !== null && (clientRequestId.length < 8 || clientRequestId.length > 100)) {
    return NextResponse.json({ message: "مفتاح طلب الإنشاء غير صالح." }, { status: 400 });
  }
  const rawAssignee = Number(source.assigneeStaffId);
  const assigneeStaffId = source.assigneeStaffId !== undefined && source.assigneeStaffId !== null
    && Number.isInteger(rawAssignee) && rawAssignee > 0 ? rawAssignee : null;
  if (isPrivate && assigneeStaffId !== null) {
    return NextResponse.json({ message: "المهمة الخاصة لك وحدك — أزل الإسناد أو اجعلها مشتركة." }, { status: 400 });
  }

  try {
    const authorize: HrTaskWriteAuthorizer = Object.assign(async (client: Parameters<HrTaskWriteAuthorizer>[0]) => {
      const live = await requireSession(client);
      return !!live && live.userId === session.userId && live.username === session.username
        && live.role === session.role && canUseTasks(live.role);
    }, { isCurrent: () => session.expiresAt >= Date.now() });
    const result = await createTask({ title, description, isPrivate, priority: priorityInput, dueAt, plannedFor, assigneeStaffId, clientRequestId }, session, authorize);
    if (!result.ok) return NextResponse.json({ message: result.error,
      ...([400, 401, 403, 404].includes(result.status) ? { creationRefusal: {
        clientRequestId, username: session.username, role: session.role, noWrite: true,
      } } : {}),
    }, { status: result.status });
    return NextResponse.json({ ...result.value, creationReceipt: {
      clientRequestId, username: session.username, role: session.role,
    } }, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء المهمة." }, { status: 500 });
  }
}


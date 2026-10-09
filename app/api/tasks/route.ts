import { NextResponse } from "next/server";
import { JSON_BODY_LIMIT_BYTES } from "@/lib/security-limits";
import { bodyErrorResponse, readJsonBody } from "@/lib/http-body";
import {
  canUseTasks, createTask, isTaskPriority, listTasks, type TaskListFilters,
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
  const rawAssignee = Number(source.assigneeStaffId);
  const assigneeStaffId = source.assigneeStaffId !== undefined && source.assigneeStaffId !== null
    && Number.isInteger(rawAssignee) && rawAssignee > 0 ? rawAssignee : null;
  if (isPrivate && assigneeStaffId !== null) {
    return NextResponse.json({ message: "المهمة الخاصة لك وحدك — أزل الإسناد أو اجعلها مشتركة." }, { status: 400 });
  }

  try {
    const result = await createTask({ title, description, isPrivate, priority: priorityInput, dueAt, assigneeStaffId }, session);
    if (!result.ok) return NextResponse.json({ message: result.error }, { status: result.status });
    return NextResponse.json(result.value, { status: 201 });
  } catch {
    return NextResponse.json({ message: "تعذّر إنشاء المهمة." }, { status: 500 });
  }
}


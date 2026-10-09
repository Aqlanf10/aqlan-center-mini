"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import {
  TASK_LINK_KIND_LABEL, TASK_PRIORITY_LABEL, TASK_STATUS_LABEL,
  type TaskLinkKind, type TaskPriority, type TaskStatus,
} from "@/lib/hr-shared";
import { canAssignTasks, canUseTasks } from "@/lib/hr-shared";
import type { SessionInfo } from "@/components/SessionProvider";

/**
 * لوحة المهام — مهامي ومهام الفريق، بقائمةٍ ولوحةٍ بسيطة.
 *
 * الخصوصية تُعرض ولا تُكسر: المهمة الخاصة تظهر لصاحبها وحده لأن الخادم هكذا
 * يردّها — ما يظهر هنا انعكاسٌ لشرط الرؤية في الخادم لا بديل عنه. والتحويل
 * من خاصةٍ إلى مشتركة فعلٌ صريح بتأكيدٍ مكتوب.
 */

interface TaskView {
  id: number;
  title: string;
  description: string;
  isPrivate: boolean;
  status: TaskStatus;
  priority: TaskPriority;
  dueAt: string | null;
  plannedFor: string | null;
  overdue: boolean;
  ownerUserId: number;
  ownerDisplayName: string;
  assigneeStaffId: number | null;
  assigneeLabel: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskCounts {
  planned: number; in_progress: number; blocked: number; completed: number; cancelled: number;
}

interface TaskListPayload {
  tasks: TaskView[];
  counts: TaskCounts;
  overdueCount: number;
}

interface DirectoryEntry {
  id: number;
  fullName: string;
  jobTitle: string;
  department: string;
  hasAccount: boolean;
}

interface TaskDetail {
  task: TaskView;
  checklist: { id: number; label: string; done: boolean; doneBy: string | null; doneAt: string | null }[];
  comments: { id: number; authorDisplayName: string; body: string; createdAt: string }[];
  events: { id: number; actorDisplayName: string; action: string; field: string | null; oldValue: string | null; newValue: string | null; createdAt: string }[];
  links: { id: number; kind: string; linkId: number; label: string; readable: boolean }[];
  permissions: { canManage: boolean; canWork: boolean };
}

const STATUS_ORDER: TaskStatus[] = ["planned", "in_progress", "blocked", "completed", "cancelled"];
const PRIORITY_STYLE: Record<TaskPriority, string> = {
  low: "bg-navy-50 text-navy-700",
  normal: "bg-info-50 text-info-900",
  high: "bg-warning-50 text-warning-900",
  urgent: "bg-danger-50 text-danger-700",
};

function fmtDate(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** مفتاح معاملةٍ للعميل: فقدان الرد ثم إعادة الإرسال لا يكرّر الإنشاء. */
function newRequestId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function HrTasksPanel({ session }: { session: SessionInfo | null }) {
  const oversight = canAssignTasks(session?.role);
  const allowed = canUseTasks(session?.role);
  const [scope, setScope] = useState<"mine" | "team">(oversight ? "team" : "mine");
  const [view, setView] = useState<"list" | "board">("list");
  const [statusFilter, setStatusFilter] = useState<"" | TaskStatus>("");
  const [priorityFilter, setPriorityFilter] = useState<"" | TaskPriority>("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [payload, setPayload] = useState<TaskListPayload>({ tasks: [], counts: { planned: 0, in_progress: 0, blocked: 0, completed: 0, cancelled: 0 }, overdueCount: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    params.set("scope", scope);
    if (statusFilter) params.set("status", statusFilter);
    if (priorityFilter) params.set("priority", priorityFilter);
    if (overdueOnly) params.set("overdue", "1");
    if (search.trim()) params.set("q", search.trim());
    return params.toString();
  }, [scope, statusFilter, priorityFilter, overdueOnly, search]);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/tasks?${query}`, { cache: "no-store" });
      if (!response.ok) {
        const payloadError = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payloadError?.message ?? "تعذّر تحميل المهام.");
      }
      setPayload((await response.json()) as TaskListPayload);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل المهام.");
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    if (!allowed) return;
    void load();
  }, [allowed, load]);

  const openDetail = useCallback(async (taskId: number) => {
    const response = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
    if (!response.ok) {
      setError("تعذّر فتح المهمة — قد تكون خاصةً لغيرك.");
      return;
    }
    setDetail((await response.json()) as TaskDetail);
  }, []);

  if (!allowed) {
    return <p className="rounded-xl bg-white p-4 text-sm text-navy-700 shadow-card">المهام خارج صلاحيات دورك.</p>;
  }

  const visibleTasks = payload.tasks;

  return (
    <section aria-label="المهام">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl bg-white p-1 shadow-card">
          <button
            onClick={() => setScope("mine")}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${scope === "mine" ? "bg-navy-800 text-white" : "text-navy-700"}`}
          >
            مهامي
          </button>
          {oversight && (
            <button
              onClick={() => setScope("team")}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${scope === "team" ? "bg-navy-800 text-white" : "text-navy-700"}`}
            >
              متابعة الفريق
            </button>
          )}
        </div>
        <div className="flex rounded-xl bg-white p-1 shadow-card" role="group" aria-label="طريقة العرض">
          <button onClick={() => setView("list")} aria-pressed={view === "list"}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${view === "list" ? "bg-navy-800 text-white" : "text-navy-700"}`}>
            قائمة
          </button>
          <button onClick={() => setView("board")} aria-pressed={view === "board"}
            className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${view === "board" ? "bg-navy-800 text-white" : "text-navy-700"}`}>
            لوحة
          </button>
        </div>
        <button
          onClick={() => setCreateOpen(true)}
          className="rounded-xl bg-accent-500 px-4 py-2 text-sm font-bold text-white shadow-card hover:bg-accent-600"
        >
          مهمة جديدة
        </button>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
        {STATUS_ORDER.map((status) => (
          <button
            key={status}
            onClick={() => setStatusFilter(statusFilter === status ? "" : status)}
            className={`rounded-xl p-2 text-right shadow-card transition ${statusFilter === status ? "bg-navy-800 text-white" : "bg-white text-navy-900"}`}
          >
            <span className="block text-lg font-bold">{payload.counts[status]}</span>
            <span className="block text-xs">{TASK_STATUS_LABEL[status]}</span>
          </button>
        ))}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="ابحث في المهام الظاهرة لك…"
          aria-label="بحث في المهام"
          className="min-w-0 flex-1 rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-1.5 rounded-xl bg-white px-3 py-2 text-sm shadow-card">
          <input type="checkbox" checked={overdueOnly} onChange={(event) => setOverdueOnly(event.target.checked)} />
          متأخرات ({payload.overdueCount})
        </label>
        <select
          value={priorityFilter}
          onChange={(event) => setPriorityFilter(event.target.value as "" | TaskPriority)}
          aria-label="الأولوية"
          className="rounded-xl border border-navy-200 bg-white px-3 py-2 text-sm"
        >
          <option value="">كل الأولويات</option>
          {(Object.keys(TASK_PRIORITY_LABEL) as TaskPriority[]).map((priority) => (
            <option key={priority} value={priority}>{TASK_PRIORITY_LABEL[priority]}</option>
          ))}
        </select>
      </div>

      {error && <p role="alert" className="mb-3 rounded-xl bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}
      {loading ? (
        <p className="rounded-xl bg-white p-6 text-center text-sm text-navy-500 shadow-card">جارٍ التحميل…</p>
      ) : visibleTasks.length === 0 ? (
        <p className="rounded-xl bg-white p-6 text-center text-sm text-navy-500 shadow-card">لا مهام في هذا النطاق.</p>
      ) : view === "list" ? (
        <ul className="grid gap-2">
          {visibleTasks.map((task) => (
            <li key={task.id}>
              <button
                onClick={() => void openDetail(task.id)}
                className="w-full rounded-xl bg-white p-3 text-right shadow-card transition hover:shadow-raised"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {task.isPrivate && (
                    <span className="rounded-md bg-navy-100 px-2 py-0.5 text-xs font-bold text-navy-800">خاصة</span>
                  )}
                  <span className="font-semibold text-navy-900">{task.title}</span>
                  <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${PRIORITY_STYLE[task.priority]}`}>
                    {TASK_PRIORITY_LABEL[task.priority]}
                  </span>
                  <span className="rounded-md bg-navy-50 px-2 py-0.5 text-xs">{TASK_STATUS_LABEL[task.status]}</span>
                  {task.overdue && <span className="rounded-md bg-danger-100 px-2 py-0.5 text-xs font-bold text-danger-700">متأخرة</span>}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-navy-600">
                  {task.assigneeLabel && <span>المسؤول: {task.assigneeLabel}</span>}
                  <span>صاحبها: {task.ownerDisplayName}</span>
                  {task.plannedFor && <span>التخطيط: {task.plannedFor}</span>}
                  {task.dueAt && <span>الاستحقاق: {fmtDate(task.dueAt)}</span>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {STATUS_ORDER.map((status) => (
            <div key={status} className="rounded-xl bg-white p-2 shadow-card">
              <h3 className="mb-2 border-b border-navy-100 pb-1 text-center text-sm font-bold text-navy-800">
                {TASK_STATUS_LABEL[status]}
              </h3>
              <ul className="grid gap-2">
                {visibleTasks.filter((task) => task.status === status).map((task) => (
                  <li key={task.id}>
                    <button onClick={() => void openDetail(task.id)} className="w-full rounded-lg bg-navy-50 p-2 text-right text-xs hover:bg-navy-100">
                      {task.isPrivate && <span className="me-1 font-bold text-navy-700">خاصة ·</span>}
                      {task.title}
                      {task.overdue && <span className="block font-bold text-danger-700">متأخرة</span>}
                    </button>
                  </li>
                ))}
                {visibleTasks.filter((task) => task.status === status).length === 0 && (
                  <li className="p-2 text-center text-xs text-navy-400">—</li>
                )}
              </ul>
            </div>
          ))}
        </div>
      )}

      {createOpen && (
        <CreateTaskModal
          session={session}
          oversight={oversight}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); void load(); }}
        />
      )}
      {detail && (
        <TaskDetailModal
          detail={detail}
          session={session}
          oversight={oversight}
          onRefresh={async () => { setDetail(null); await load(); }}
          onReloadDetail={async () => { const response = await fetch(`/api/tasks/${detail.task.id}`, { cache: "no-store" }); if (response.ok) setDetail((await response.json()) as TaskDetail); }}
        />
      )}
    </section>
  );
}

function CreateTaskModal({ session, oversight, onClose, onCreated }: {
  session: SessionInfo | null;
  oversight: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueAt, setDueAt] = useState("");
  const [plannedFor, setPlannedFor] = useState("");
  const [assignee, setAssignee] = useState("");
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!oversight) return;
    void (async () => {
      const response = await fetch("/api/hr/directory", { cache: "no-store" });
      if (response.ok) setDirectory((await response.json()) as DirectoryEntry[]);
    })();
  }, [oversight]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title, description, isPrivate, priority,
          dueAt: dueAt || null,
          plannedFor: plannedFor || null,
          assigneeStaffId: !isPrivate && assignee ? Number(assignee) : null,
          clientRequestId: newRequestId(),
        }),
      });
      if (!response.ok) {
        const payloadError = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payloadError?.message ?? "تعذّر إنشاء المهمة.");
      }
      onCreated();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "تعذّر إنشاء المهمة.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onClose={onClose} label="مهمة جديدة" initialFocus="input[maxlength='200']">
      <div className="mx-auto w-full max-w-lg rounded-2xl bg-white p-5 shadow-raised">
        <h2 className="mb-4 text-lg font-bold text-navy-900">مهمة جديدة</h2>
        <div className="grid gap-3">
        <label className="grid gap-1 text-sm font-semibold text-navy-800">
          العنوان
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200}
            className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal" />
        </label>
        <label className="grid gap-1 text-sm font-semibold text-navy-800">
          الوصف
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={4000}
            className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal" />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-sm font-semibold text-navy-800">
            الأولوية
            <select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}
              className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal">
              {(Object.keys(TASK_PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold text-navy-800">
            تاريخ التخطيط
            <input type="date" value={plannedFor} onChange={(event) => setPlannedFor(event.target.value)}
              className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-navy-800">
            موعد الاستحقاق
            <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)}
              className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-navy-800">
          <input type="checkbox" checked={isPrivate} onChange={(event) => { setIsPrivate(event.target.checked); if (event.target.checked) setAssignee(""); }} />
          مهمة خاصة — لا يراها غيري
        </label>
        {oversight && !isPrivate && (
          <label className="grid gap-1 text-sm font-semibold text-navy-800">
            المسؤول (من ملفات الطاقم)
            <select value={assignee} onChange={(event) => setAssignee(event.target.value)}
              className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal">
              <option value="">— بلا إسناد —</option>
              {directory.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.fullName}{entry.jobTitle ? ` — ${entry.jobTitle}` : ""}{entry.hasAccount ? " (لهم حساب)" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {error && <p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-xl bg-navy-100 px-4 py-2 text-sm font-semibold text-navy-800">إلغاء</button>
          <button onClick={() => void submit()} disabled={busy || !title.trim()}
            className="rounded-xl bg-accent-500 px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {busy ? "جارٍ الحفظ…" : "إنشاء"}
          </button>
        </div>
      </div>
      </div>
    </Modal>
  );
}

const EVENT_LABEL: Record<string, string> = {
  create: "إنشاء", update: "تعديل", status: "حالة", assign: "إسناد",
  comment: "تعليق", checklist: "قائمة التحقق", visibility: "الخصوصية", link: "ربط", unlink: "فكّ ربط",
};

function TaskDetailModal({ detail, session, oversight, onRefresh, onReloadDetail }: {
  detail: TaskDetail;
  session: SessionInfo | null;
  oversight: boolean;
  onRefresh: () => Promise<void>;
  onReloadDetail: () => Promise<void>;
}) {
  const { task } = detail;
  const [comment, setComment] = useState("");
  const [checklistLabel, setChecklistLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmShared, setConfirmShared] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // نموذج التحرير الإداري — لمن يملك canManage: العنوان والأولوية والموعدان والإسناد.
  const [editTitle, setEditTitle] = useState(task.title);
  const [editPriority, setEditPriority] = useState<TaskPriority>(task.priority);
  const [editDueAt, setEditDueAt] = useState(task.dueAt ? task.dueAt.slice(0, 16) : "");
  const [editPlannedFor, setEditPlannedFor] = useState(task.plannedFor ?? "");
  const [editAssignee, setEditAssignee] = useState(task.assigneeStaffId ? String(task.assigneeStaffId) : "");
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [editOpen, setEditOpen] = useState(false);

  useEffect(() => {
    if (!editOpen || !oversight) return;
    void (async () => {
      const response = await fetch("/api/hr/directory", { cache: "no-store" });
      if (response.ok) setDirectory((await response.json()) as DirectoryEntry[]);
    })();
  }, [editOpen, oversight]);

  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // حماية الحفظ فوق نسخةٍ أحدث: الطابع كما رأيناه — والخادم يردّ 409 عند الاختلاف.
        body: JSON.stringify({ ...body, expectedUpdatedAt: task.updatedAt }),
      });
      if (!response.ok) {
        const payloadError = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payloadError?.message ?? "تعذّر التحديث.");
      }
      await onReloadDetail();
      return true;
    } catch (patchError) {
      setError(patchError instanceof Error ? patchError.message : "تعذّر التحديث.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const post = async (path: string, body: Record<string, unknown>, method = "POST"): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${task.id}/${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const payloadError = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(payloadError?.message ?? "تعذّر التنفيذ.");
      }
      await onReloadDetail();
      return true;
    } catch (postError) {
      setError(postError instanceof Error ? postError.message : "تعذّر التنفيذ.");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submitManagementEdit = async () => {
    const body: Record<string, unknown> = {
      title: editTitle.trim(),
      priority: editPriority,
      dueAt: editDueAt ? new Date(editDueAt).toISOString() : null,
      plannedFor: editPlannedFor || null,
    };
    if (oversight && !task.isPrivate) {
      body.assigneeStaffId = editAssignee ? Number(editAssignee) : null;
    }
    const ok = await patch(body);
    if (ok) setEditOpen(false);
  };

  return (
    <Modal onClose={() => void onRefresh()} label={`المهمة: ${task.title}`} alignTop>
      <div className="mx-auto w-full max-w-2xl rounded-2xl bg-white p-5 shadow-raised">
        <h2 className="mb-4 text-lg font-bold text-navy-900">{task.title}</h2>
        <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {task.isPrivate && <span className="rounded-md bg-navy-100 px-2 py-0.5 font-bold text-navy-800">خاصة — لك وحدك</span>}
          <span className="rounded-md bg-navy-50 px-2 py-0.5">{TASK_STATUS_LABEL[task.status]}</span>
          <span className={`rounded-md px-2 py-0.5 font-semibold ${PRIORITY_STYLE[task.priority]}`}>{TASK_PRIORITY_LABEL[task.priority]}</span>
          <span className="text-navy-600">صاحبها: {task.ownerDisplayName}</span>
          {task.assigneeLabel && <span className="text-navy-600">المسؤول: {task.assigneeLabel}</span>}
          {task.dueAt && <span className="text-navy-600">الاستحقاق: {fmtDate(task.dueAt)}</span>}
          {task.overdue && <span className="rounded-md bg-danger-100 px-2 py-0.5 font-bold text-danger-700">متأخرة</span>}
        </div>

        {task.description && <p className="whitespace-pre-wrap rounded-xl bg-navy-50 p-3 text-sm">{task.description}</p>}
        {task.plannedFor && <p className="text-xs text-navy-600">تاريخ التخطيط: <span className="ltr-nums">{task.plannedFor}</span>{task.dueAt ? <> — موعد الاستحقاق: <span className="ltr-nums">{fmtDate(task.dueAt)}</span></> : null}</p>}

        {/* التحرير الإداري — لمن يملك canManage (صاحبها أو الإدارة المخولة) */}
        {detail.permissions.canManage && !editOpen && (
          <button onClick={() => { setEditOpen(true); setEditTitle(task.title); setEditPriority(task.priority); setEditDueAt(task.dueAt ? task.dueAt.slice(0, 16) : ""); setEditPlannedFor(task.plannedFor ?? ""); setEditAssignee(task.assigneeStaffId ? String(task.assigneeStaffId) : ""); }}
            className="justify-self-start rounded-xl bg-navy-100 px-4 py-2 text-xs font-semibold text-navy-800">
            تعديل العنوان والأولوية والمواعيد…
          </button>
        )}
        {detail.permissions.canManage && editOpen && (
          <div role="form" aria-label="تعديل بيانات المهمة" className="grid gap-2 rounded-xl border border-navy-100 p-3">
            <label className="grid gap-1 text-sm font-semibold text-navy-800">
              العنوان
              <input value={editTitle} onChange={(event) => setEditTitle(event.target.value)} maxLength={200}
                className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-sm font-semibold text-navy-800">
                الأولوية
                <select value={editPriority} onChange={(event) => setEditPriority(event.target.value as TaskPriority)}
                  className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal">
                  {(Object.keys(TASK_PRIORITY_LABEL) as TaskPriority[]).map((p) => (
                    <option key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-sm font-semibold text-navy-800">
                تاريخ التخطيط
                <input type="date" value={editPlannedFor} onChange={(event) => setEditPlannedFor(event.target.value)}
                  className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
              </label>
              <label className="grid gap-1 text-sm font-semibold text-navy-800">
                موعد الاستحقاق
                <input type="datetime-local" value={editDueAt} onChange={(event) => setEditDueAt(event.target.value)}
                  className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal ltr-nums" />
              </label>
              {oversight && !task.isPrivate && (
                <label className="grid gap-1 text-sm font-semibold text-navy-800">
                  المسؤول
                  <select value={editAssignee} onChange={(event) => setEditAssignee(event.target.value)}
                    className="rounded-xl border border-navy-200 px-3 py-2 text-sm font-normal">
                    <option value="">— بلا إسناد —</option>
                    {directory.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.fullName}{entry.jobTitle ? ` — ${entry.jobTitle}` : ""}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="flex gap-2">
              <button disabled={busy || !editTitle.trim()} onClick={() => void submitManagementEdit()}
                className="rounded-xl bg-accent-500 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                {busy ? "جارٍ الحفظ…" : "حفظ التعديل"}
              </button>
              <button onClick={() => setEditOpen(false)} className="rounded-xl bg-white px-4 py-1.5 text-xs font-semibold text-navy-800">تراجع</button>
            </div>
          </div>
        )}

        {/* شريط الحالة — لمن يعمل في المهمة */}
        {detail.permissions.canWork && (
          <div className="flex flex-wrap gap-1.5">
            {STATUS_ORDER.map((status) => (
              <button key={status} disabled={busy || status === task.status}
                onClick={() => void patch({ status })}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60 ${
                  status === task.status ? "bg-navy-800 text-white" : "bg-white text-navy-700 shadow-card hover:bg-navy-50"}`}>
                {TASK_STATUS_LABEL[status]}
              </button>
            ))}
          </div>
        )}

        {/* التحويل الصريح: خاصة → مشتركة */}
        {task.isPrivate && detail.permissions.canManage && !confirmShared && (
          <button onClick={() => setConfirmShared(true)}
            className="justify-self-start rounded-xl border border-warning-500 bg-warning-50 px-4 py-2 text-sm font-semibold text-warning-900">
            تحويل إلى مهمة مشتركة…
          </button>
        )}
        {confirmShared && (
          <div role="alertdialog" aria-label="تأكيد التحويل" className="rounded-xl border border-warning-500 bg-warning-50 p-3 text-sm">
            <p className="mb-2 font-semibold text-warning-900">
              المهمة الخاصة ستصبح مشتركة: ستظهر للإدارة المخولة وللمسند إليه. لا رجوع بعدها إلى الخاصة.
            </p>
            <div className="flex gap-2">
              <button disabled={busy} onClick={() => { setConfirmShared(false); void patch({ convertToShared: true }); }}
                className="rounded-xl bg-warning-700 px-4 py-1.5 text-xs font-bold text-white disabled:opacity-50">نعم، اجعلها مشتركة</button>
              <button onClick={() => setConfirmShared(false)} className="rounded-xl bg-white px-4 py-1.5 text-xs font-semibold text-navy-800">تراجع</button>
            </div>
          </div>
        )}

        {/* قائمة التحقق */}
        <section aria-label="قائمة التحقق" className="grid gap-2">
          <h3 className="text-sm font-bold text-navy-900">قائمة التحقق</h3>
          <ul className="grid gap-1">
            {detail.checklist.map((item) => (
              <li key={item.id} className="flex items-center gap-2 rounded-lg bg-white p-2 text-sm shadow-card">
                <input
                  type="checkbox"
                  checked={item.done}
                  disabled={busy || !detail.permissions.canWork}
                  onChange={(event) => void post("checklist", { op: "toggle", itemId: item.id, done: event.target.checked })}
                  aria-label={item.label}
                />
                <span className={`flex-1 ${item.done ? "text-navy-400 line-through" : ""}`}>{item.label}</span>
                {item.doneBy && <span className="text-xs text-navy-500">أكملها {item.doneBy}</span>}
                {detail.permissions.canWork && (
                  <button onClick={() => void post("checklist", { op: "remove", itemId: item.id })}
                    className="rounded-md px-2 py-0.5 text-xs text-danger-700 hover:bg-danger-50">حذف</button>
                )}
              </li>
            ))}
          </ul>
          {detail.permissions.canWork && (
            <form className="flex gap-2" onSubmit={(event) => {
              event.preventDefault();
              if (!checklistLabel.trim()) return;
              // المسودة تبقى حتى ينجح الحفظ — وفشله يظهر سببه، وفقدان الرد
              // ثم إعادة الإرسال بنفس المفتاح لا يكرّر البند.
              void post("checklist", { op: "add", label: checklistLabel.trim(), clientRequestId: newRequestId() })
                .then((ok) => { if (ok) setChecklistLabel(""); });
            }}>
              <input value={checklistLabel} onChange={(event) => setChecklistLabel(event.target.value)} maxLength={300}
                placeholder="بند جديد…" className="flex-1 rounded-xl border border-navy-200 px-3 py-2 text-sm" />
              <button type="submit" disabled={busy || !checklistLabel.trim()}
                className="rounded-xl bg-navy-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">إضافة</button>
            </form>
          )}
        </section>

        {/* التعليقات */}
        <section aria-label="التعليقات" className="grid gap-2">
          <h3 className="text-sm font-bold text-navy-900">التعليقات</h3>
          <ul className="grid gap-2">
            {detail.comments.map((entry) => (
              <li key={entry.id} className="rounded-xl bg-white p-3 text-sm shadow-card">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-1 text-xs text-navy-600">
                  <span className="font-semibold text-navy-800">{entry.authorDisplayName}</span>
                  <span>{fmtDate(entry.createdAt)}</span>
                </div>
                <p className="whitespace-pre-wrap">{entry.body}</p>
              </li>
            ))}
            {detail.comments.length === 0 && <li className="text-xs text-navy-500">لا تعليقات بعد.</li>}
          </ul>
          {detail.permissions.canWork && (
            <form className="flex gap-2" onSubmit={(event) => {
              event.preventDefault();
              if (!comment.trim()) return;
              void post("comments", { body: comment.trim(), clientRequestId: newRequestId() })
                .then((ok) => { if (ok) setComment(""); });
            }}>
              <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={2000}
                placeholder="اكتب تعليقًا — يُسجَّل باسمك" className="flex-1 rounded-xl border border-navy-200 px-3 py-2 text-sm" />
              <button type="submit" disabled={busy || !comment.trim()}
                className="rounded-xl bg-navy-800 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">إرسال</button>
            </form>
          )}
        </section>

        {/* الروابط */}
        <section aria-label="السجلات المربوطة" className="grid gap-2">
          <h3 className="text-sm font-bold text-navy-900">سجلات مربوطة</h3>
          <ul className="grid gap-1 text-sm">
            {detail.links.map((link) => (
              <li key={link.id} className="flex items-center gap-2 rounded-lg bg-white p-2 shadow-card">
                <span className="rounded-md bg-navy-50 px-2 py-0.5 text-xs">{link.kind === "patient" ? "مريض" : link.kind === "lab_order" ? "أمر مختبر" : "بند مخزون"}</span>
                {link.readable ? <span className="flex-1">{link.label}</span>
                  : <span className="flex-1 text-xs text-navy-500">سجل مربوط — لا صلاحية لك بقراءته</span>}
                {detail.permissions.canManage && link.readable && (
                  <button onClick={() => void post(`links?linkId=${link.id}`, {}, "DELETE")}
                    className="rounded-md px-2 py-0.5 text-xs text-danger-700 hover:bg-danger-50">فكّ</button>
                )}
              </li>
            ))}
            {detail.links.length === 0 && <li className="text-xs text-navy-500">لا سجلات مربوطة.</li>}
          </ul>
          {detail.permissions.canManage && (
            <p className="text-xs text-navy-500">
              فكّ الربط يتم من هنا. أما إضافة الربط من شاشة السجل نفسه (المريض/المختبر/المخزون) فتُستكمل في مرحلة قادمة —
              ووصولك إلى السجل المرتبط يُفحص عند كل قراءة، وإكمال المهمة لا يغيّر السجل أبدًا.
            </p>
          )}
        </section>

        {/* سجل التغييرات */}
        <section aria-label="سجل التغييرات" className="grid gap-1">
          <h3 className="text-sm font-bold text-navy-900">سجل التغييرات</h3>
          <ul className="grid max-h-56 gap-1 overflow-y-auto text-xs">
            {detail.events.map((event) => {
              const isLinkEvent = event.action === "link" || event.action === "unlink";
              const kindLabel = isLinkEvent && event.field && event.field in TASK_LINK_KIND_LABEL
                ? TASK_LINK_KIND_LABEL[event.field as TaskLinkKind]
                : null;
              // أحداث الربط بقيمٍ محجوبة: لا يظهر وسم السجل لمن لا يملك صلاحيته.
              const valuesHidden = isLinkEvent && event.newValue === null && event.oldValue === null;
              return (
                <li key={event.id} className="rounded-lg bg-navy-50 px-3 py-1.5 text-navy-800">
                  <span className="font-semibold">{event.actorDisplayName}</span> — {EVENT_LABEL[event.action] ?? event.action}
                  {kindLabel ? ` بسجل ${kindLabel}` : event.field && event.newValue ? `: ${event.field} → ${event.newValue}` : ""}
                  {valuesHidden ? " — القيم محجوبة عنك (لا صلاحية لك بالسجل المرتبط)" : ""}
                  <span className="ms-2 text-navy-500">{fmtDate(event.createdAt)}</span>
                </li>
              );
            })}
          </ul>
        </section>

        {error && <p role="alert" className="rounded-xl bg-danger-50 p-3 text-sm text-danger-700">{error}</p>}

        <div className="flex justify-end">
          <button onClick={() => void onRefresh()} className="rounded-xl bg-navy-100 px-4 py-2 text-sm font-semibold text-navy-800">إغلاق</button>
        </div>
        {oversight && <p className="text-xs text-navy-400">جلسة {session?.username ?? ""} — كل تحديثٍ هنا يُسجَّل باسمك فعلًا.</p>}
      </div>
      </div>
    </Modal>
  );
}

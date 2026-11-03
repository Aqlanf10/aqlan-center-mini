"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { CLINIC_ZONE_FALLBACK } from "@/lib/clinicZone";
import { clinicDateString } from "@/lib/schedule";
import { formatMoney, isCurrency } from "@/lib/money";
import {
  LAB_FILTER_LABEL, LAB_PRIORITY_LABEL, LAB_STATUS_LABEL, daysLate, filterOrders, isDueToday,
  type LabFilter, type LabOrder, type LabOrderClinicalDTO,
} from "@/lib/lab";
import { CanonicalLabOrderActions } from "./CanonicalLabOrderActions";
import { CanonicalLabCreateForm } from "./CanonicalLabCreateForm";
import { LAB_BACKLOG_FILTER_LABEL, LAB_BACKLOG_FILTERS, labBacklogPatientHref, type LabBacklogFilter, type LabBacklogSnapshot } from "@/lib/lab-backlog";

/**
 * لوحة المختبر للجلسة الموحّدة (M2 slices 66–67).
 *
 * GET /api/lab يعيد أوامر نطاق مرضاك (`own`: مرضاك وحدهم)، والتكاليف لا تصل إلا لمن يملك
 * finance.cost-prices.view. قائمة المتابعة الشاملة (GET /api/lab/backlog) لمن نطاقه «كل
 * المرضى»، والمهام المرتبطة لمن يملك tasks.use. لا يُركَّب هنا المسار القديم ولا طلباته.
 * نقل الحالة وتغيير الموعد والإلغاء وسجل الحركة (clinical.lab.order وclinical.lab.cancel)
 * في CanonicalLabOrderActions؛ وإنشاء الطلبات بمفتاح طلب يمنع التكرار في CanonicalLabCreateForm.
 */
type Order = LabOrderClinicalDTO & Partial<Pick<LabOrder, "costMinor" | "costCurrency">>;
interface Feed {
  orders: Order[]; labs: { labName: string }[]; projection: { costs: boolean };
  /** The creation form's directory (slice 68), sent only to those who may create orders. */
  labParties?: { id: number; name: string }[]; doctors?: { id: number; name: string }[];
}
const FILTERS: LabFilter[] = ["late", "outstanding", "pending", "received", "remake", "delivered", "all"];

export function CanonicalLabBoard() {
  const session = useSession();
  const whole = session?.isOwner === true || session?.patientScope === "all";
  const holds = (capability: string) => session?.isOwner === true || (session?.capabilities ?? []).includes(capability);
  const canOrder = holds("clinical.lab.order"), canCancel = holds("clinical.lab.cancel");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<LabFilter>("late");
  const [backlog, setBacklog] = useState<LabBacklogSnapshot | null>(null);
  const [backlogFilter, setBacklogFilter] = useState<LabBacklogFilter>("overdue");
  const [backlogError, setBacklogError] = useState<string | null>(null);
  const sequence = useRef(0);
  // The creation form keeps the last directory: a refresh (every 30 s) must never unmount
  // a form being filled in.
  const [directory, setDirectory] = useState<Pick<Feed, "labParties" | "doctors">>({});
  const today = clinicDateString(new Date(), CLINIC_ZONE_FALLBACK);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    // Stale rows never outlive a failed or newer read.
    setFeed(null); setError(null);
    try {
      const response = await fetch("/api/lab", { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (current !== sequence.current) return;
      if (!response.ok || !payload || !Array.isArray(payload.orders)) { setError(payload?.message ?? "تعذّر تحميل أعمال المختبر."); return; }
      setFeed(payload as Feed);
      if (Array.isArray(payload.labParties)) setDirectory({ labParties: payload.labParties, doctors: payload.doctors });
    } catch { if (current === sequence.current) setError("تعذّر الاتصال بالخادم."); }
    if (!whole) return;
    setBacklog(null); setBacklogError(null);
    try {
      const response = await fetch(`/api/lab/backlog?filter=${backlogFilter}`, { cache: "no-store" });
      const payload = await response.json().catch(() => null);
      if (current !== sequence.current) return;
      if (!response.ok || !payload?.counts) { setBacklogError(payload?.message ?? "تعذّر تحميل قائمة المتابعة."); return; }
      setBacklog(payload as LabBacklogSnapshot);
    } catch { if (current === sequence.current) setBacklogError("تعذّر الاتصال بالخادم."); }
  }, [whole, backlogFilter]);

  useEffect(() => {
    // The first read starts after the effect (never a synchronous setState inside it).
    const first = setTimeout(() => void load(), 0);
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { clearTimeout(first); clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  const orders = feed ? filterOrders(feed.orders, filter, today) : [];
  return (
    <section dir="rtl" aria-labelledby="lab-board-title" className="mx-auto max-w-5xl space-y-4" data-testid="canonical-lab-board">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 id="lab-board-title" className="text-lg font-black text-navy-900">أعمال المختبر</h1>
          <p className="text-xs text-slate-600">{whole ? "كل أعمال المركز المفتوحة" : "أعمال مرضاك"}{canOrder ? "" : " — للعرض فقط"}.</p>
        </div>
        <button type="button" onClick={() => void load()} className="min-h-11 rounded-xl border border-slate-300 px-3 text-xs font-bold text-navy-800">تحديث</button>
      </header>

      {canOrder ? <CanonicalLabCreateForm directory={directory} onCreated={() => void load()} /> : null}

      {whole ? (
        <section aria-label="قائمة المتابعة الشاملة" className="rounded-2xl border border-slate-200 bg-white p-3" data-testid="lab-backlog">
          <div className="flex flex-wrap gap-2">
            {LAB_BACKLOG_FILTERS.map(key => (
              <button key={key} type="button" aria-pressed={backlogFilter === key} onClick={() => setBacklogFilter(key)}
                className={`min-h-10 rounded-xl px-3 text-xs font-bold ${backlogFilter === key ? "bg-navy-900 text-white" : "border border-slate-300 text-navy-900"}`}>
                {LAB_BACKLOG_FILTER_LABEL[key]}
                {backlog ? <span className="mr-1">({key === "all" ? backlog.counts.orders : key === "preparing" ? backlog.counts.preparing : key === "with_lab" ? backlog.counts.withLab : key === "overdue" ? backlog.counts.overdue : backlog.counts.awaitingFitting})</span> : null}
              </button>
            ))}
          </div>
          {backlogError ? <p role="alert" className="mt-2 text-sm text-red-800">{backlogError}</p> : null}
          {backlog ? (
            backlog.items.length === 0 ? <p className="mt-2 text-sm text-slate-600">لا شيء في هذا التصنيف.</p> : (
              <ul className="mt-2 divide-y divide-slate-100" data-testid="lab-backlog-items">
                {backlog.items.map(item => (
                  <li key={item.id} className="py-2 text-sm" data-backlog={item.id}>
                    <Link href={labBacklogPatientHref(item.patientId)} className="font-bold text-navy-900 underline-offset-2 hover:underline">{item.patientName}</Link>
                    <span className="mx-2 text-xs text-slate-600">{item.workType}{item.teeth ? ` · ${item.teeth}` : ""} · {item.labName}</span>
                    <span dir="ltr" className="text-xs text-slate-700">{item.dueDate}</span>
                    {item.tasks.length ? <span className="mr-2 text-xs text-sky-800">مهام: {item.tasks.map(task => task.title).join("، ")}</span> : null}
                  </li>
                ))}
              </ul>
            )
          ) : backlogError ? null : <p role="status" className="mt-2 text-xs text-slate-600">جارٍ التحميل…</p>}
        </section>
      ) : null}

      <div className="flex flex-wrap gap-2" role="group" aria-label="تصفية الأوامر">
        {FILTERS.map(key => (
          <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}
            className={`min-h-10 rounded-xl px-3 text-xs font-bold ${filter === key ? "bg-navy-900 text-white" : "border border-slate-300 text-navy-900"}`}>
            {LAB_FILTER_LABEL[key]}{feed ? ` (${filterOrders(feed.orders, key, today).length})` : ""}
          </button>
        ))}
      </div>
      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      {feed ? (
        orders.length === 0 ? <p className="text-sm text-slate-600">لا أوامر في هذا التصنيف.</p> : (
          <ul className="space-y-2" data-testid="lab-orders">
            {orders.map(order => {
              const late = daysLate(order, today);
              return (
                <li key={order.id} className={`rounded-2xl border bg-white p-3 text-sm ${late > 0 ? "border-red-200" : "border-slate-200"}`} data-order={order.id}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="font-bold text-navy-900">{order.patientName}{order.patientNumber ? <span className="mr-1 text-xs text-slate-600">({order.patientNumber})</span> : null}</span>
                    <span className="text-xs font-bold text-navy-800">{LAB_STATUS_LABEL[order.status] ?? order.status}</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-700">
                    {order.workType}{order.toothNumbers ? ` · أسنان ${order.toothNumbers}` : ""} · {order.labName}{order.doctorName ? ` · ${order.doctorName}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-700">
                    أُرسل <span dir="ltr">{order.sentDate}</span> · التسليم <span dir="ltr">{order.dueDate}</span>
                    {late > 0 ? <span className="mr-2 font-bold text-red-700">متأخر {late} يومًا</span> : isDueToday(order, today) ? <span className="mr-2 font-bold text-amber-700">يُسلَّم اليوم</span> : null}
                    {order.priority !== "normal" ? <span className="mr-2 font-bold text-amber-800">{LAB_PRIORITY_LABEL[order.priority]?.label}</span> : null}
                  </p>
                  {feed.projection.costs && order.costMinor != null && order.costCurrency && isCurrency(order.costCurrency)
                    ? <p className="mt-1 text-xs text-slate-700">التكلفة: {formatMoney(order.costMinor, order.costCurrency)}</p> : null}
                  <CanonicalLabOrderActions key={`${order.id}:${order.status}:${order.dueDate}`} order={order} canOrder={canOrder} canCancel={canCancel} onChanged={() => void load()} />
                </li>
              );
            })}
          </ul>
        )
      ) : error ? null : <p role="status" className="text-sm text-slate-600">جارٍ تحميل أعمال المختبر…</p>}
    </section>
  );
}

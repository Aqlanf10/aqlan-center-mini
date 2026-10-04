"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useSession } from "@/components/SessionProvider";
import { isAdmin } from "@/lib/roles";

interface LabIdentity { partyId: number; partyName: string }
interface ClinicalOrder {
  orderId: number; patientName: string; workType: string; teeth: string | null;
  dueDate: string; status: string; financialStatus: string;
}
interface ComparisonSnapshot { party: { id: number; name: string }; orders: ClinicalOrder[] }
interface LabReconciliationModalProps {
  initialPartyId?: number | null;
  onClose: () => void;
  // Kept for caller compatibility. Comparison/navigation never reports a payment success.
  onSuccess?: () => void;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function readLabs(value: unknown): LabIdentity[] {
  if (!object(value) || !Array.isArray(value.labs)) throw new Error("Invalid lab catalog");
  const ids = new Set<number>();
  return value.labs.map((row: unknown) => {
    if (!object(row) || !validId(row.partyId) || ids.has(row.partyId) || typeof row.partyName !== "string" || !row.partyName.trim()) throw new Error("Invalid lab identity");
    ids.add(row.partyId);
    // Legacy overview scalar amounts/counts are intentionally not consumed here.
    return { partyId: row.partyId, partyName: row.partyName };
  });
}
function readComparison(value: unknown, partyId: number | null): ComparisonSnapshot {
  if (!object(value) || !object(value.party) || !validId(value.party.id) || value.party.id !== partyId
    || typeof value.party.name !== "string" || !value.party.name.trim() || !Array.isArray(value.orders) || value.orders.length > 300) throw new Error("Invalid comparison scope");
  const ids = new Set<number>();
  const orders = value.orders.map((row: unknown): ClinicalOrder => {
    if (!object(row) || !validId(row.orderId) || ids.has(row.orderId) || typeof row.patientName !== "string"
      || typeof row.workType !== "string" || typeof row.dueDate !== "string" || typeof row.status !== "string"
      || typeof row.financialStatus !== "string" || !(row.teeth == null || typeof row.teeth === "string")) throw new Error("Invalid comparison row");
    ids.add(row.orderId);
    // Legacy GET substitutes zero/preferred currency for missing originals. It cannot
    // prove original cost or payable remaining; never carry its money into this UI.
    return { orderId: row.orderId, patientName: row.patientName, workType: row.workType,
      teeth: row.teeth ?? null, dueDate: row.dueDate, status: row.status, financialStatus: row.financialStatus };
  });
  return { party: { id: value.party.id, name: value.party.name }, orders };
}

type ReadOwner<T> = { scope: readonly unknown[]; active: boolean; sequence: number; controller: AbortController | null; snapshot: T | null };
type ReadState<T> = { owner: ReadOwner<T>; phase: "loading" | "ready" | "error"; data: T | null };
/** Owner identity, rather than a reusable party key, retires A → B → A reads. */
function useComparisonRead<T>(url: string | null, authorityKey: string | null, decode: (value: unknown) => T) {
  const owner = useMemo<ReadOwner<T>>(() => ({ scope: [url, authorityKey, decode], active: false, sequence: 0, controller: null, snapshot: null }), [url, authorityKey, decode]);
  const [state, setState] = useState<ReadState<T> | null>(null);
  const retire = useCallback(() => { owner.active = false; owner.sequence++; owner.snapshot = null; owner.controller?.abort(); }, [owner]);
  useLayoutEffect(() => { owner.active = true; return retire; }, [owner, retire]);
  const reload = useCallback(async () => {
    if (!owner.active || !url || !authorityKey) return;
    const sequence = ++owner.sequence;
    owner.controller?.abort(); owner.snapshot = null;
    const controller = new AbortController(); owner.controller = controller;
    const current = () => owner.active && owner.sequence === sequence && !controller.signal.aborted;
    setState({ owner, phase: "loading", data: null });
    try {
      const response = await fetch(url, { cache: "no-store", signal: controller.signal });
      if (!current()) return;
      if (!response.ok) throw new Error("Comparison unavailable");
      const payload: unknown = await response.json();
      if (!current()) return;
      const data = decode(payload);
      owner.snapshot = data; setState({ owner, phase: "ready", data });
    } catch {
      if (current()) setState({ owner, phase: "error", data: null });
    }
  }, [owner, url, authorityKey, decode]);
  useEffect(() => { void reload(); }, [reload]);
  const current = state?.owner === owner && owner.active && url && authorityKey ? state : null;
  const data = current?.phase === "ready" && owner.snapshot === current.data ? current.data : null;
  const isCurrent = (snapshot: T | null) => owner.active && snapshot !== null && owner.snapshot === snapshot;
  return { data, phase: current?.phase ?? "loading", reload, retire, isCurrent };
}

export function LabReconciliationModal({ initialPartyId, onClose }: LabReconciliationModalProps) {
  const session = useSession();
  const admin = isAdmin(session?.role) && !!session?.username.trim();
  const [closed, setClosed] = useState(false);
  const authorityKey = admin && session && !closed ? JSON.stringify([session.username, session.role, session.permissions ?? null]) : null;
  const authority = useMemo(() => ({ key: authorityKey, initialPartyId }), [authorityKey, initialPartyId]);
  const catalog = useComparisonRead("/api/finance/lab-reconciliation", authorityKey, readLabs);
  const [choice, setChoice] = useState<{ authority: typeof authority; id: number | null } | null>(null);
  const interaction = useMemo(() => ({ authority, choice }), [authority, choice]);
  const activeInteraction = useRef<typeof interaction | null>(null);
  useLayoutEffect(() => {
    activeInteraction.current = interaction;
    return () => { if (activeInteraction.current === interaction) activeInteraction.current = null; };
  }, [interaction]);
  const requestedId = choice?.authority === authority ? choice.id : validId(initialPartyId) ? initialPartyId : null;
  const selectedPartyId = catalog.data?.some((lab) => lab.partyId === requestedId) ? requestedId : null;
  const decode = useCallback((value: unknown) => readComparison(value, selectedPartyId), [selectedPartyId]);
  const detail = useComparisonRead(selectedPartyId ? `/api/finance/lab-reconciliation?partyId=${selectedPartyId}` : null, authorityKey, decode);
  const snapshot = detail.data;
  const [selection, setSelection] = useState<{ snapshot: ComparisonSnapshot; ids: number[] } | null>(null);
  const selectedIds = snapshot && selection?.snapshot === snapshot ? selection.ids : [];
  const close = () => { activeInteraction.current = null; catalog.retire(); detail.retire(); setClosed(true); onClose(); };
  const canCompare = () => activeInteraction.current === interaction && catalog.isCurrent(catalog.data) && detail.isCurrent(snapshot);
  const toggle = (id: number) => {
    if (!snapshot || !canCompare() || !snapshot.orders.some((row) => row.orderId === id)) return;
    setSelection((previous) => {
      const ids = previous?.snapshot === snapshot ? previous.ids : [];
      return { snapshot, ids: ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id] };
    });
  };
  const toggleAll = () => {
    if (!snapshot || !canCompare()) return;
    setSelection((previous) => ({ snapshot, ids: previous?.snapshot === snapshot && previous.ids.length === snapshot.orders.length
      ? [] : snapshot.orders.map((row) => row.orderId) }));
  };
  const guardStatement = (event: MouseEvent<HTMLAnchorElement>) => { if (!canCompare()) event.preventDefault(); };

  if (closed) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-navy-950/75 p-3 backdrop-blur-xs sm:p-4"
    onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="lab-comparison-title" dir="rtl" className="my-8 w-full max-w-4xl space-y-5 rounded-3xl border border-slate-200 bg-white p-5 shadow-2xl sm:p-6">
      <header className="flex items-start justify-between gap-3 border-b border-slate-100 pb-4">
        <div><h2 id="lab-comparison-title" className="text-lg font-black text-slate-900">مقارنة أوامر المختبر</h2>
          <p className="mt-1 text-xs text-slate-600">اختر الأوامر للمراجعة السريرية فقط. التحديد لا يسدد الأوامر ولا يغير حالتها.</p></div>
        <button type="button" onClick={close} aria-label="إغلاق مقارنة المختبر" className="rounded-xl px-3 py-2 text-slate-600 hover:bg-slate-100">✕</button>
      </header>
      {!admin ? <p role="alert">هذه المقارنة وروابط المالية متاحة للمدير فقط.</p> : <>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs leading-6 text-amber-950">
          <p>المقارنة المالية والمتبقي على الفواتير ورصيد المختبر غير متاحة في هذه النافذة. التكلفة الأصلية للأمر لا تمثل الدين المتبقي.</p>
          <p>لا يتوفر اقتراح دفع مجمع هنا. راجع كل فاتورة على حدة في كشف الجهة قبل الدفع.</p>
        </div>
        {catalog.phase === "loading" ? <p role="status">جارٍ تحميل قائمة المختبرات…</p> : null}
        {catalog.phase === "error" ? <div role="alert"><p>تعذّر التحقق من قائمة المختبرات؛ هذا لا يعني عدم وجود مختبرات.</p>
          <button type="button" onClick={() => void catalog.reload()}>إعادة تحميل قائمة المختبرات</button></div> : null}
        {catalog.data ? <div>
          <label htmlFor="lab-comparison-party" className="mb-1 block text-xs font-bold">اختر مختبراً للمقارنة</label>
          <select id="lab-comparison-party" value={selectedPartyId ?? ""} className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm"
            onChange={(event) => {
              if (activeInteraction.current !== interaction || !catalog.isCurrent(catalog.data)) return;
              const id = Number(event.target.value);
              if (event.target.value !== "" && !catalog.data?.some((lab) => lab.partyId === id)) return;
              const nextId = validId(id) ? id : null;
              if (nextId === selectedPartyId) return;
              activeInteraction.current = null; detail.retire(); setChoice({ authority, id: nextId });
            }}>
            <option value="">اختر المختبر</option>
            {catalog.data.map((lab) => <option key={lab.partyId} value={lab.partyId}>{lab.partyName}</option>)}
          </select>
          {catalog.data.length === 0 ? <p className="mt-2 text-xs">لا توجد مختبرات في القائمة المقروءة.</p> : null}
        </div> : null}
        {selectedPartyId && detail.phase === "loading" ? <p role="status">جارٍ تحميل أوامر المختبر…</p> : null}
        {selectedPartyId && detail.phase === "error" ? <div role="alert"><p>تعذّر التحقق من أوامر المختبر؛ لا يمكن استنتاج عدم وجود أوامر أو ديون.</p>
          <button type="button" onClick={() => void detail.reload()}>إعادة تحميل أوامر المختبر</button></div> : null}
        {snapshot ? <>
          <div className="space-y-2 text-xs text-slate-600">
            <h3 className="font-bold text-slate-900">الأوامر المحمّلة للمقارنة: {snapshot.orders.length}</h3>
            <p>القائمة مأخوذة من نافذة تصل إلى 300 أمر على مستوى المركز، وليست كامل سجل المختبر أو كشفاً شهرياً.</p>
            <p>الربط الحالي قد يعتمد على اسم المختبر؛ ظهور الأمر هنا لا يثبت ملكية فاتورته. الحالات المعروضة علامات مسجلة وليست دليلاً على سداد الدين.</p>
            <p>المحدد للمقارنة فقط: {selectedIds.length}</p>
            <button type="button" onClick={toggleAll} disabled={snapshot.orders.length === 0} className="font-bold text-brand-blue">
              {selectedIds.length > 0 && selectedIds.length === snapshot.orders.length ? "إلغاء تحديد المحمّل" : "تحديد الأوامر المحمّلة"}
            </button>
          </div>
          {snapshot.orders.length === 0 ? <p role="status" className="text-sm">لا توجد أوامر لهذا المختبر ضمن النافذة المحمّلة؛ قد توجد أوامر خارجها.</p> : <div className="max-h-80 overflow-auto rounded-2xl border border-slate-200">
            <table className="w-full text-right text-xs"><thead className="sticky top-0 bg-slate-100"><tr>
              <th className="p-3">تحديد</th><th className="p-3">الأمر</th><th className="p-3">المريض</th><th className="p-3">العمل والأسنان</th><th className="p-3">موعد التسليم</th><th className="p-3">الحالة المسجلة</th><th className="p-3">المقارنة المالية</th>
            </tr></thead><tbody className="divide-y divide-slate-100">{snapshot.orders.map((order) => <tr key={order.orderId} className={selectedIds.includes(order.orderId) ? "bg-sky-50" : ""}>
              <td className="p-3"><input type="checkbox" aria-label={`مقارنة الأمر RX-${order.orderId}`} checked={selectedIds.includes(order.orderId)} onChange={() => toggle(order.orderId)} /></td>
              <td className="p-3 font-mono">RX-{order.orderId}</td><td className="p-3">{order.patientName}</td>
              <td className="p-3">{order.workType}{order.teeth ? <span className="block font-mono">{order.teeth}</span> : null}</td>
              <td className="p-3 font-mono">{order.dueDate}</td><td className="p-3"><span>{order.status}</span><span className="block">{order.financialStatus}</span></td>
              <td className="p-3">غير متاحة</td>
            </tr>)}</tbody></table>
          </div>}
          <div className="space-y-2 border-t border-slate-100 pt-4 text-xs">
            <p>يفتح الرابط كشف الجهة لمراجعة وسداد الفواتير الفردية. راجع المتبقي في صف الفاتورة ومعاينة الدفع؛ إجمالي رأس الكشف ليس مرجعاً لتسوية الأوامر المحددة.</p>
            <a href={`/finance/parties/${snapshot.party.id}`} onClick={guardStatement} onAuxClick={guardStatement} className="inline-block rounded-xl bg-navy-900 px-4 py-3 font-bold text-white">
              مراجعة فواتير {snapshot.party.name} في كشف الجهة
            </a>
          </div>
        </> : null}
      </>}
    </section>
  </div>;
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";
import { useSession } from "../SessionProvider";
import { canHandleMoney } from "@/lib/roles";
import { financeAccessFor } from "@/lib/finance-permissions";

interface PatientResult {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
}

interface DebtorPatient {
  patientId: number;
  patientName: string;
  phone: string | null;
  /** (P-01/D-1) عملة دلو هذا الدين — يُعرض مستحقه بها، لا برمزٍ واحد للجميع. */
  currency?: Currency;
  dueMinor: number;
}

interface QuickCollectModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectPatient: (patient: { id: number; name: string; dueMinor?: number; currency?: Currency }) => void;
  debtors: DebtorPatient[];
  currency: Currency;
}

export function QuickCollectModal({
  isOpen,
  onClose,
  onSelectPatient,
  debtors,
  currency,
}: QuickCollectModalProps) {
  const session = useSession();
  const principalKey = session?.username.trim()
    ? JSON.stringify([session.username, session.role, session.permissions ?? null]) : "";
  const access = financeAccessFor(session?.role, session?.permissions?.financeAccess);
  const canCollect = canHandleMoney(session?.role) && (session?.role !== "cashier" || access.collectPayments);
  const canSeeDebtors = session?.role !== "cashier" || access.viewPatientLedger;
  const visibleDebtors = canSeeDebtors ? debtors : [];
  const [query, setQuery] = useState("");
  const [generation, setGeneration] = useState(0);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [result, setResult] = useState<{
    query: string; principalKey: string; generation: number; request: number; rows: PatientResult[];
  } | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lifetime = useRef({ open: false, principalKey: "", generation: 0, request: 0, awaitClosed: false });
  const closeCallback = useRef(onClose);
  const trimmedQuery = query.trim();

  useLayoutEffect(() => { closeCallback.current = onClose; }, [onClose]);
  useLayoutEffect(() => {
    const owner = lifetime.current;
    const principalChanged = owner.principalKey !== "" && owner.principalKey !== principalKey;
    if (!isOpen) owner.awaitClosed = false;
    else if (principalChanged) owner.awaitClosed = true;
    owner.open = isOpen && Boolean(principalKey) && canCollect && !owner.awaitClosed;
    owner.principalKey = principalKey;
    owner.generation += 1;
    owner.request += 1;
    setGeneration(owner.generation);
    setOpenFor(owner.open ? principalKey : null);
    setQuery("");
    setResult(null);
    setIsSearching(false);
    if (isOpen && (principalChanged || !canCollect)) closeCallback.current();
    const focus = owner.open ? setTimeout(() => inputRef.current?.focus(), 60) : null;
    return () => {
      if (focus !== null) clearTimeout(focus);
      owner.open = false;
      owner.generation += 1;
      owner.request += 1;
    };
  }, [isOpen, principalKey, canCollect]);

  useEffect(() => {
    const owner = lifetime.current;
    if (!isOpen || !principalKey || trimmedQuery.length < 2 || !owner.open
      || owner.principalKey !== principalKey || owner.generation !== generation) return;
    const request = ++owner.request;
    let retired = false;
    const current = () => !retired && owner.open && owner.principalKey === principalKey
      && owner.generation === generation && owner.request === request;
    setResult(null);
    setIsSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/patients?q=${encodeURIComponent(trimmedQuery)}`, { cache: "no-store" });
        if (!res.ok || !current()) return;
        const data = await res.json();
        // A response/body can finish after an edit, close or principal change.
        // Logical retirement, not transport cancellation, owns its authority.
        if (!current() || !Array.isArray(data)) return;
        setResult({ query: trimmedQuery, principalKey, generation, request, rows: data.slice(0, 10) });
      } catch {
        // A rejected/aborted retired request must not erase a newer result.
        if (current()) setResult(null);
      } finally {
        if (current()) setIsSearching(false);
      }
    }, 200);

    return () => {
      retired = true;
      clearTimeout(timer);
      if (owner.request === request) owner.request += 1;
    };
  }, [isOpen, principalKey, generation, trimmedQuery]);

  const currentOwner = () => lifetime.current.open && lifetime.current.principalKey === principalKey
    && lifetime.current.generation === generation;
  const withdrawSearch = () => {
    // Also retire retained callbacks from default debtor suggestions before
    // React commits the new query, including a clear/short-query transition.
    lifetime.current.generation += 1;
    setGeneration(lifetime.current.generation);
    lifetime.current.request += 1;
    setResult(null);
    setIsSearching(false);
  };
  const retireModal = () => {
    lifetime.current.open = false;
    lifetime.current.generation += 1;
    setOpenFor(null);
    withdrawSearch();
  };
  const close = () => { if (currentOwner()) { retireModal(); onClose(); } };
  const searchResults = result && result.query === trimmedQuery && result.principalKey === principalKey
    && result.generation === generation ? result.rows : [];

  if (!isOpen || !principalKey || !canCollect || openFor !== principalKey) return null;

  return (
    <div
      role="dialog"
      aria-label="اختيار مريض لإصدار سند قبض"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-xs p-4"
      onClick={close}
    >
      <div
        className="w-full max-w-lg rounded-3xl border border-emerald-200 bg-white p-5 shadow-2xl transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800 text-lg">
              💵
            </span>
            <div>
              <h3 className="text-base font-black text-navy-900">إصدار سند قبض سريع</h3>
              <p className="text-xs text-slate-500 font-medium">
                ابحث عن المريض أو اختر من قائمة المديونيات للتحصيل الفوري
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="إغلاق"
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            ✕
          </button>
        </div>

        {/* حقل البحث بالاسم أو الهاتف */}
        <div className="mb-4">
          <div className="relative">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                withdrawSearch();
                setQuery(e.target.value);
              }}
              placeholder="ابحث بالاسم أو رقم الهاتف أو الملف…"
              className="w-full rounded-2xl border border-slate-200 bg-slate-50/70 px-4 py-3 text-sm font-bold text-navy-900 placeholder:text-slate-400 outline-none focus:border-emerald-500 focus:bg-white focus:ring-2 focus:ring-emerald-100"
            />
            {isSearching ? (
              <span className="absolute left-3.5 top-3.5 text-xs text-slate-400 animate-spin">
                ⏳
              </span>
            ) : null}
          </div>
        </div>

        {/* نتائج البحث المباشر إن وجدت */}
        {query.trim().length >= 2 ? (
          <div className="mb-3 max-h-60 overflow-y-auto space-y-1.5">
            <p className="text-[11px] font-black text-slate-400 mb-1">نتائج البحث:</p>
            {searchResults.length === 0 && !isSearching ? (
              <p className="p-4 text-center text-xs text-slate-400">لا توجد نتائج مطابقة للبحث.</p>
            ) : (
              searchResults.map((p) => {
                const debtor = visibleDebtors.find((d) => d.patientId === p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => {
                      if (!currentOwner() || !result || result.query !== trimmedQuery
                        || result.principalKey !== principalKey || result.generation !== generation
                        || result.request !== lifetime.current.request || !result.rows.includes(p)) return;
                      retireModal();
                      onSelectPatient({
                        id: p.id,
                        name: p.fullName,
                        dueMinor: debtor?.dueMinor,
                        currency: debtor?.currency,
                      });
                      onClose();
                    }}
                    className="flex w-full items-center justify-between rounded-xl border border-slate-100 bg-slate-50/50 p-2.5 text-right transition-colors hover:border-emerald-300 hover:bg-emerald-50/40"
                  >
                    <div>
                      <span className="block text-xs font-black text-navy-900">{p.fullName}</span>
                      <span className="text-[10px] text-slate-500 font-mono">
                        ملف #{p.patientNumber} {p.phone ? `· هاتف: ${p.phone}` : ""}
                      </span>
                    </div>
                    <div className="text-left">
                      {debtor && debtor.dueMinor > 0 ? (
                        <span className="rounded-lg bg-rose-100 px-2 py-0.5 text-[11px] font-bold text-rose-800 font-mono">
                          مستحق: {formatMoney(debtor.dueMinor, isCurrency(debtor.currency) ? debtor.currency : currency)}
                        </span>
                      ) : (
                        <span className="text-[10px] font-bold text-emerald-700">تحصيل دفعة ↗</span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        ) : !canSeeDebtors ? (
          <p role="note" className="rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
            المديونيات مخفية بحسب صلاحيات الحساب. ابحث عن المريض لإصدار سند.
          </p>
        ) : (
          /* قائمة المرضى المدينين المقترحين */
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-black text-slate-600">
                أبرز المرضى أصحاب المديونيات ({visibleDebtors.length})
              </span>
              <span className="text-[10px] text-slate-400">اختر مريضاً للتحصيل الفوري</span>
            </div>
            <div className="max-h-64 overflow-y-auto space-y-1.5 pe-1">
              {visibleDebtors.length === 0 ? (
                <p className="rounded-2xl border border-slate-100 bg-slate-50 p-6 text-center text-xs text-slate-400">
                  لا توجد مديونيات معلقة حالياً على المرضى.
                </p>
              ) : (
                visibleDebtors.slice(0, 8).map((debtor) => (
                  <button
                    key={`${debtor.patientId}-${debtor.currency ?? currency}`}
                    type="button"
                    onClick={() => {
                      if (!currentOwner() || trimmedQuery.length >= 2) return;
                      retireModal();
                      onSelectPatient({
                        id: debtor.patientId,
                        name: debtor.patientName,
                        dueMinor: debtor.dueMinor,
                        currency: debtor.currency,
                      });
                      onClose();
                    }}
                    className="flex w-full items-center justify-between rounded-2xl border border-slate-200/80 bg-white p-2.5 text-right transition-all hover:border-emerald-400 hover:bg-emerald-50/50 shadow-2xs"
                  >
                    <div>
                      <span className="block text-xs font-black text-navy-900">
                        {debtor.patientName}
                      </span>
                      {debtor.phone ? (
                        <span className="text-[10px] text-slate-500 font-mono">
                          {debtor.phone}
                        </span>
                      ) : null}
                    </div>
                    <div className="text-left">
                      <p className="text-xs font-mono font-black text-rose-700">
                        {formatMoney(debtor.dueMinor, isCurrency(debtor.currency) ? debtor.currency : currency)}
                      </p>
                      <span className="text-[10px] font-extrabold text-emerald-700">
                        قبض الآن 💳
                      </span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        <div className="mt-4 border-t border-slate-100 pt-3 flex justify-end">
          <button
            type="button"
            onClick={close}
            className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-bold text-slate-600 hover:bg-slate-50"
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}

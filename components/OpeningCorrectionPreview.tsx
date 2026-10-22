"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoney, isCurrency, type Currency } from "@/lib/money";

/** The dry-run reply, allowlisted: only the figures this panel shows. */
export interface OpeningCorrectionPreviewView {
  currentAmountMinor: number | null;
  settledMinor: number;
  receiptCount: number;
  afterAmountMinor: number | null;
  currentRemainingMinor: number;
  afterRemainingMinor: number;
  allowed: boolean;
  message: string | null;
}

const minor = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function readOpeningCorrectionPreview(payload: unknown, currency: Currency): OpeningCorrectionPreviewView {
  const row = payload && typeof payload === "object" ? (payload as { preview?: unknown }).preview : null;
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Invalid opening preview");
  const value = row as Record<string, unknown>;
  if (value.currency !== currency || !isCurrency(value.currency)
    || !(value.currentAmountMinor === null || minor(value.currentAmountMinor))
    || !Number.isSafeInteger(value.settledMinor) || !minor(value.receiptCount)
    || !(value.afterAmountMinor === null || minor(value.afterAmountMinor))
    || !minor(value.currentRemainingMinor) || !minor(value.afterRemainingMinor)
    || typeof value.allowed !== "boolean" || value.allowed !== (value.message === null)
    || !(value.message === null || typeof value.message === "string")) throw new Error("Invalid opening preview");
  return {
    currentAmountMinor: value.currentAmountMinor as number | null, settledMinor: value.settledMinor as number,
    receiptCount: value.receiptCount as number, afterAmountMinor: value.afterAmountMinor as number | null,
    currentRemainingMinor: value.currentRemainingMinor as number, afterRemainingMinor: value.afterRemainingMinor as number,
    allowed: value.allowed, message: value.message as string | null,
  };
}

type State = { phase: "idle" } | { phase: "loading" } | { phase: "error"; message: string } | { phase: "ready"; view: OpeningCorrectionPreviewView };

/**
 * (FIN-INT legacy) Dry run before correcting or deleting a legacy balance: the server applies
 * the same rule the write applies and writes nothing. The write rechecks under its own lock.
 */
export function OpeningCorrectionPreview({ patientId, currency, amount }: { patientId: number; currency: Currency; amount: string }) {
  const [state, setState] = useState<State>({ phase: "idle" });
  const request = useRef<AbortController | null>(null);
  // The caller keys this panel by its figures, so any edit retires a shown result; unmount aborts.
  useEffect(() => () => request.current?.abort(), []);

  async function run(clear: boolean) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ phase: "loading" });
    const query = new URLSearchParams({ preview: "1", patientId: String(patientId), currency });
    if (clear) query.set("clear", "1"); else query.set("amount", amount);
    try {
      const response = await fetch(`/api/opening-balances?${query}`, { cache: "no-store", signal: controller.signal });
      const payload: unknown = await response.json().catch(() => null);
      if (controller.signal.aborted) return;
      if (!response.ok) {
        const message = payload && typeof payload === "object" && typeof (payload as { message?: unknown }).message === "string"
          ? (payload as { message: string }).message : "تعذّرت معاينة الأثر.";
        setState({ phase: "error", message });
        return;
      }
      setState({ phase: "ready", view: readOpeningCorrectionPreview(payload, currency) });
    } catch {
      if (!controller.signal.aborted) setState({ phase: "error", message: "تعذّرت معاينة الأثر؛ لا يعني ذلك أن التصحيح مسموح أو مرفوض." });
    }
  }

  return (
    <div className="mb-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs" aria-label="معاينة أثر التصحيح" data-testid="opening-correction-preview">
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void run(false)} disabled={state.phase === "loading" || !amount.trim()}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 font-bold text-navy-900 disabled:opacity-50">
          عاين أثر التعديل قبل الحفظ
        </button>
        <button type="button" onClick={() => void run(true)} disabled={state.phase === "loading"}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1 font-bold text-slate-700 disabled:opacity-50">
          عاين أثر الحذف
        </button>
      </div>
      {state.phase === "loading" ? <p role="status" className="mt-2">جارٍ حساب الأثر دون أي حفظ…</p> : null}
      {state.phase === "error" ? <p role="alert" className="mt-2 font-bold text-red-700">{state.message}</p> : null}
      {state.phase === "ready" ? (
        <div className="mt-2 space-y-1">
          <p>الأصل الحالي: <span className="num">{state.view.currentAmountMinor === null ? "—" : formatMoney(state.view.currentAmountMinor, currency)}</span>
            {" · "}المحصّل المثبت عليه: <span className="num">{formatMoney(state.view.settledMinor, currency)}</span> ({state.view.receiptCount} سند)</p>
          <p>المتبقي الآن: <span className="num">{formatMoney(state.view.currentRemainingMinor, currency)}</span>
            {" ← "}بعد {state.view.afterAmountMinor === null ? "الحذف" : "التعديل"}: <span className="num">{formatMoney(state.view.afterRemainingMinor, currency)}</span></p>
          {state.view.allowed
            ? <p className="font-bold text-emerald-800">معاينة فقط — لم يُحفظ شيء. الحفظ يعيد التحقق نفسه.</p>
            : <p role="alert" className="font-bold text-red-700">{state.view.message}</p>}
        </div>
      ) : null}
    </div>
  );
}

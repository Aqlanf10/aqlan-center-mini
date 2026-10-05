"use client";

import { formatMoney } from "@/lib/money";
import type { TodayReadState, VisitReadiness } from "./useChairReadiness";

const STATE_ICON = { ok: "✓", attention: "!", info: "·" } as const;

/**
 * (CHAIR-1 Slices 1–2) شارة الجاهزية ورصيد المريض على صفّ الوصول.
 *
 * سطرٌ قصير لا يزاحم أزرار النداء: «جاهز ✓» أو «يحتاج اطلاعًا (٢)» تنفتح بلمسة على القائمة وزرّ
 * «أقِرّ الجاهزية». والرصيد معلومةٌ لمن يرى المال: كهرماني إن بلغ عتبة الإعداد، ولا يمنع شيئًا.
 */
export function ReadinessChip({
  item, visit, state, canClear, busy, onClear, onRetry,
}: {
  item: VisitReadiness | undefined;
  visit: { id: number; patientId: number | null; status: string; chair: number | null };
  state: TodayReadState;
  canClear: boolean;
  busy: boolean;
  onClear: (visitId: number) => void;
  onRetry: () => void;
}) {
  // Matching a visit ID alone can attach another patient's cached details to a
  // relinked row. Movement state must agree before offering clearance as well.
  const matchesPatient = item?.visitId === visit.id && item.patientId === visit.patientId;
  const coherent = matchesPatient && item.status === visit.status && item.chair === visit.chair;
  if (!item || state !== "ready" || !coherent) {
    const warnings = matchesPatient ? item?.alerts ?? [] : [];
    return (
      <div className="mt-1 space-y-1 text-[11px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-slate-600" role="status">
            {state === "loading" ? "الجاهزية قيد التحقق" : "الجاهزية غير متاحة؛ أعد التحقق"}
          </span>
          {state !== "loading" && (
            <button type="button" onClick={onRetry} disabled={busy}
              className="min-h-[44px] min-w-[44px] rounded-lg border border-slate-300 bg-white px-2 py-1 font-bold text-slate-700 disabled:opacity-40">
              أعد التحقق
            </button>
          )}
        </div>
        {warnings.length > 0 && (
          <p className="font-bold text-amber-900">آخر تنبيه محفوظ: {[...new Set(warnings)].join(" • ")}</p>
        )}
      </div>
    );
  }
  const balances = item.balances ?? [];
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      {item.cleared ? (
        <span
          className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-bold text-emerald-800"
          title={item.cleared.by ? `أقرّها ${item.cleared.by}` : undefined}
        >
          جاهز ✓
        </span>
      ) : item.checklist === null ? (
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-bold text-slate-500">لم تُقَرّ الجاهزية</span>
      ) : (
        <details className="group">
          <summary
            className={`cursor-pointer list-none rounded-full px-2 py-0.5 text-[11px] font-bold ${
              (item.attention ?? 0) > 0 ? "bg-amber-100 text-amber-900" : "bg-slate-100 text-slate-600"
            }`}
          >
            {(item.attention ?? 0) > 0 ? `يحتاج اطلاعًا (${item.attention})` : "لم تُقَرّ الجاهزية"}
          </summary>
          <div className="mt-1 rounded-xl border border-slate-200 bg-white p-2 text-[11px] shadow-xs">
            <ul className="space-y-0.5">
              {item.checklist.map((line) => (
                <li
                  key={line.key}
                  className={line.state === "attention" ? "font-bold text-amber-900" : line.state === "ok" ? "text-emerald-800" : "text-slate-500"}
                >
                  {STATE_ICON[line.state]} {line.label}
                </li>
              ))}
            </ul>
            {canClear && item.signedAt === null && item.status !== "done" && <button
              type="button"
              onClick={() => onClear(item.visitId)}
              disabled={busy}
              className="mt-1.5 rounded-lg bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40"
            >
              أقِرّ الجاهزية
            </button>}
          </div>
        </details>
      )}
      {balances.map((line) => (
        <span
          key={line.currency}
          className={`rounded-full px-2 py-0.5 text-[11px] font-bold ${
            line.warn ? "bg-amber-200 text-amber-950" : "bg-slate-100 text-slate-600"
          }`}
          title="رصيدٌ مستحق — معلومة لا تمنع العلاج"
        >
          عليه {formatMoney(line.dueMinor, line.currency)}
        </span>
      ))}
    </div>
  );
}

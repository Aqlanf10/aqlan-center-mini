import { CURRENCIES, formatMoney, type Currency } from "@/lib/money";

/**
 * (P1-3) حالة إقفال الوردية كما هي — لا «مقفل ومطابق» لكل وردية مقفلة.
 *
 * «مطابق» فقط إذا كان الفرق صفرًا في كل العملات؛ وإلا «عجز/زيادة» بمبلغه وسببه.
 * والورديات المقفلة قبل حفظ المتوقَّع (قبل الهجرة 0014) يُحسب فرقها بالقاعدة نفسها
 * ويوسَم «محسوب». ومعه رابط تقرير الإقفال (Z) للطباعة.
 */
export interface ShiftCloseInfo {
  id: number;
  status: "open" | "closed";
  counted: Record<Currency, number> | null;
  difference?: Record<Currency, number> | null;
  differenceReason?: string | null;
  expectedSource?: "stored" | "computed";
}

export function ShiftCloseStatus({ shift, compact = false }: { shift: ShiftCloseInfo; compact?: boolean }) {
  if (shift.status === "open") {
    return (
      <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
        مفتوحة
      </span>
    );
  }
  if (!shift.counted || !shift.difference) {
    return (
      <span className="inline-flex rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-600">
        مقفلة بلا جرد محفوظ
      </span>
    );
  }
  const off = CURRENCIES.filter((currency) => shift.difference![currency] !== 0);
  const computed = shift.expectedSource === "computed" ? " (محسوب)" : "";
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {off.length === 0 ? (
        <span className="inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
          مقفل ومطابق{computed}
        </span>
      ) : (
        off.map((currency) => {
          const value = shift.difference![currency];
          return (
            <span
              key={currency}
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                value < 0 ? "bg-rose-100 text-rose-800" : "bg-amber-100 text-amber-800"
              }`}
            >
              {value < 0 ? "عجز" : "زيادة"} {formatMoney(Math.abs(value), currency)}{computed}
            </span>
          );
        })
      )}
      {!compact && off.length > 0 && shift.differenceReason ? (
        <span className="text-[10px] text-slate-500">السبب: {shift.differenceReason}</span>
      ) : null}
      <a
        href={`/print/shift/${shift.id}`}
        target="_blank"
        rel="noopener"
        className="text-[10px] font-bold text-brand-blue hover:underline"
      >
        تقرير الإقفال
      </a>
    </span>
  );
}

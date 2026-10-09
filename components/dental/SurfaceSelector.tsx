"use client";

import { SURFACES } from "@/lib/dental";

/**
 * (INV-LINK TOOTH) اختيار أسطح السن (M O D B L) — المصدر الواحد لمحرّر المخطط السريري ولبند الحشوة في الفاتورة.
 * النقر يضيف السطح أو يزيله؛ الترتيب القانوني للحفظ من `normalizeSurfaces` في `lib/dental`.
 */
export const SURFACE_DESCRIPTIONS: Record<string, { label: string; desc: string }> = {
  M: { label: "M", desc: "إنسي (Mesial)" },
  O: { label: "O", desc: "إطباقي (Occlusal)" },
  D: { label: "D", desc: "وحشي (Distal)" },
  B: { label: "B", desc: "دهليزي (Buccal)" },
  L: { label: "L", desc: "لساني (Lingual)" },
};

export function toggleSurface(current: readonly string[], surface: string): string[] {
  return current.includes(surface) ? current.filter((item) => item !== surface) : [...current, surface];
}

export function SurfaceSelector({ value, onChange }: {
  value: readonly string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="grid grid-cols-5 gap-2">
      {SURFACES.map((surface) => {
        const active = value.includes(surface);
        const meta = SURFACE_DESCRIPTIONS[surface];
        return (
          <button
            key={surface}
            type="button"
            onClick={() => onChange(toggleSurface(value, surface))}
            aria-pressed={active}
            data-testid={`surface-${surface}`}
            className={`flex flex-col items-center justify-center rounded-xl p-2 text-center transition-all border ${
              active
                ? "border-navy-900 bg-navy-900 text-white shadow-sm"
                : "border-slate-200 bg-white text-slate-700 hover:border-slate-300"
            }`}
          >
            <span className="text-sm font-black">{meta?.label || surface}</span>
            <span className="text-[9px] font-semibold mt-0.5 opacity-80">{meta?.desc || ""}</span>
          </button>
        );
      })}
    </div>
  );
}

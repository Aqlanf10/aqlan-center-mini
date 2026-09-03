"use client";

import { useState } from "react";
import Link from "next/link";
import { FINANCE_PILLARS, type FinancePillar } from "@/components/financeLinks";

interface FinanceNavigationProps {
  currentHref: string;
}

export function FinanceNavigation({ currentHref }: FinanceNavigationProps) {
  // Find which pillar contains currentHref
  const currentPillar = FINANCE_PILLARS.find((p) =>
    p.links.some((l) => l.href === currentHref)
  ) || FINANCE_PILLARS[0];

  const [selectedPillarId, setSelectedPillarId] = useState<"all" | "cash" | "ar" | "ap" | "gl">(
    currentPillar.id
  );

  return (
    <nav className="mb-6 rounded-2xl border border-slate-200 bg-white p-3 shadow-xs" aria-label="التنقل المالي الطبي الموحد">
      {/* تصنيف الركائز الأربع المعيارية */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-100 pb-2.5">
        <span className="pe-1 text-[11px] font-black text-slate-400">الركائز المالية:</span>
        <button
          type="button"
          onClick={() => setSelectedPillarId("all")}
          className={`rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
            selectedPillarId === "all"
              ? "bg-navy-900 text-white shadow-xs"
              : "bg-slate-100 text-slate-600 hover:bg-slate-200"
          }`}
        >
          كل الأقسام
        </button>

        {FINANCE_PILLARS.map((pillar) => {
          const isSelected = selectedPillarId === pillar.id;
          const containsCurrent = pillar.links.some((l) => l.href === currentHref);

          return (
            <button
              key={pillar.id}
              type="button"
              onClick={() => setSelectedPillarId(pillar.id)}
              className={`relative inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                isSelected
                  ? "bg-navy-900 text-white shadow-xs"
                  : containsCurrent
                  ? "border border-brand-orange/40 bg-brand-orange/10 text-brand-orange font-extrabold hover:bg-brand-orange/20"
                  : "bg-slate-50 text-slate-700 hover:bg-slate-100"
              }`}
            >
              <span>{pillar.name}</span>
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-mono ${
                  isSelected
                    ? "bg-white/20 text-white"
                    : containsCurrent
                    ? "bg-brand-orange text-white"
                    : "bg-slate-200 text-slate-600"
                }`}
              >
                {pillar.links.length}
              </span>
            </button>
          );
        })}
      </div>

      {/* الروابط الفرعية للركيزة المحددة أو الكل */}
      <div className="pt-2.5">
        {selectedPillarId === "all" ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {FINANCE_PILLARS.map((pillar) => (
              <div key={pillar.id} className="rounded-xl border border-slate-100 bg-slate-50/50 p-2.5">
                <div className="mb-1.5 flex items-center justify-between gap-1 border-b border-slate-200/60 pb-1 text-[11px] font-black text-navy-800">
                  <span>{pillar.name}</span>
                  <span className="text-[10px] font-normal text-slate-500">{pillar.badge}</span>
                </div>
                <div className="space-y-1">
                  {pillar.links.map((link) => {
                    const isCurrent = link.href === currentHref;
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        className={`block rounded-lg px-2 py-1 text-xs font-semibold transition-colors ${
                          isCurrent
                            ? "bg-navy-900 text-white shadow-xs font-bold"
                            : "text-slate-700 hover:bg-white hover:text-navy-900"
                        }`}
                      >
                        {link.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {FINANCE_PILLARS.find((p) => p.id === selectedPillarId)?.links.map((link) => {
              const isCurrent = link.href === currentHref;
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold transition-colors ${
                    isCurrent
                      ? "bg-navy-900 text-white shadow-xs"
                      : "border border-slate-200 bg-white text-slate-700 hover:border-slate-300 hover:bg-slate-50"
                  }`}
                >
                  <span>{link.label}</span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </nav>
  );
}

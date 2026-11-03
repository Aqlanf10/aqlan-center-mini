"use client";

import Link from "next/link";
import { CATEGORY_LABEL } from "@/lib/settings-definitions";
import type { ProjectedSettingsDomain } from "@/lib/settings-navigation";

const ARABIC_INDEX = ["١", "٢", "٣", "٤", "٥", "٦", "٧", "٨"] as const;

export function SettingsInstitutionalDirectory({
  domains,
  canonical,
}: {
  domains: readonly ProjectedSettingsDomain[];
  canonical: boolean;
}) {
  const authorizedLinksCount = domains.reduce((sum, domain) => sum + domain.links.length, 0);

  return (
    <section
      className="mt-6 rounded-2xl border border-slate-200 bg-white p-4"
      aria-label="النطاقات المؤسسية للإعدادات والإدارات المتخصصة"
      data-testid={canonical ? "settings-pending-areas" : "settings-institutional-directory"}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-black text-navy-950">الدليل المؤسسي للإعدادات والإدارات المتخصصة</h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            {canonical
              ? "موزّع على ثمانية نطاقات مؤسسية؛ الشاشات المنتقلة إلى الهوية الموحّدة تظهر لحسابك بصلاحياتها الدقيقة، وما لم يُنقل بعد يبقى محجوبًا حتى اكتمال مساره."
              : "تنظيم مؤسسي موحّد يربط فئات الإعدادات المركزية بالشاشات المتخصصة المصرّح لحسابك بفتحها فقط."}
          </p>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-bold text-slate-600">
          {domains.length} نطاقات · {authorizedLinksCount} شاشة متخصصة متاحة
        </span>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {domains.map((domain, index) => {
          const scopeCategories = [...domain.categories, ...domain.relatedCategories];
          return (
            <div
              key={domain.id}
              className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/60 p-3.5"
            >
              <div className="flex items-start gap-2.5">
                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-navy-950 text-xs font-black text-white">
                  {ARABIC_INDEX[index] ?? String(index + 1)}
                </span>
                <div className="min-w-0">
                  <h3 className="text-xs font-black text-navy-950">{domain.title}</h3>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{domain.subtitle}</p>
                </div>
              </div>

              {scopeCategories.length > 0 ? (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  <span className="text-[10px] font-bold text-slate-400">فئات المفاتيح:</span>
                  {scopeCategories.map((category) => (
                    <span
                      key={`${domain.id}-${category}`}
                      className="rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-600"
                    >
                      {CATEGORY_LABEL[category]}
                    </span>
                  ))}
                </div>
              ) : null}

              {domain.links.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-200/80 pt-2.5">
                  {domain.links.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      title={link.description}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-navy-900 transition hover:border-navy-300 hover:bg-navy-50"
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="mt-3 border-t border-slate-200/80 pt-2 text-[11px] text-slate-400">
                  {canonical
                    ? "تُدار مفاتيح هذا النطاق من القائمة أعلاه؛ الشاشات المتخصصة غير المنتقلة للهوية الموحّدة لا تُعرض هنا."
                    : "لا توجد شاشات فرعية إضافية مخصّصة لدورك في هذا النطاق."}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

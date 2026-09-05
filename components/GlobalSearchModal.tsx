"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "./Modal";
import { useClinicName } from "./SettingsProvider";
import { Icon, type IconName } from "./Icon";
import { useSession } from "./SessionProvider";
import { canHandleMoney, isAdmin } from "@/lib/roles";

interface PatientSummary {
  id: number;
  patientNumber: string;
  fullName: string;
  phone: string | null;
  medicalAlert: string | null;
}

interface CommandItem {
  id: string;
  category: "actions" | "navigation" | "patients";
  title: string;
  subtitle?: string;
  icon: IconName;
  badge?: string;
  badgeClass?: string;
  onSelect: () => void;
}

export function GlobalSearchModal({
  isOpen,
  onClose,
  onOpenNewAppointment,
  onOpenNewPatient,
}: {
  isOpen: boolean;
  onClose: () => void;
  onOpenNewAppointment: () => void;
  onOpenNewPatient: () => void;
}) {
  const router = useRouter();
  const session = useSession();
  const clinicName = useClinicName();
  const searchId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [patientResults, setPatientResults] = useState<PatientSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setPatientResults([]);
      setSelectedIndex(0);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    if (query.trim().length < 2) {
      setPatientResults([]);
      setSearching(false);
      return;
    }

    const controller = new AbortController();
    setPatientResults([]);
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/patients?q=${encodeURIComponent(query.trim())}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          if (!controller.signal.aborted && Array.isArray(data)) {
            setPatientResults(data.slice(0, 8));
          }
        }
      } catch {
        /* ignore */
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 200);

    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, isOpen]);

  const handleNavigate = (path: string) => {
    onClose();
    router.push(path);
  };

  const navItems: CommandItem[] = [
    {
      id: "nav-today",
      category: "navigation",
      title: "شاشة اليوم والانتظار السريري",
      subtitle: "متابعة تدفق العيادة وقائمة الانتظار والكراسي",
      icon: "tooth",
      onSelect: () => handleNavigate("/"),
    },
    {
      id: "nav-appointments",
      category: "navigation",
      title: "جدول المواعيد والحجوزات",
      subtitle: "إدارة المواعيد اليومية والتذكيرات",
      icon: "calendar",
      onSelect: () => handleNavigate("/appointments"),
    },
    {
      id: "nav-patients",
      category: "navigation",
      title: "سجل وملفات المرضى",
      subtitle: "بحث في قاعدة بيانات المرضى والملفات السريرية",
      icon: "user",
      onSelect: () => handleNavigate("/patients"),
    },
  ];

  if (canHandleMoney(session?.role)) {
    navItems.push({
      id: "nav-finance",
      category: "navigation",
      title: "الصندوق والمالية",
      subtitle: "سندات القبض والصرف وحركات الخزينة",
      icon: "wallet",
      onSelect: () => handleNavigate("/finance"),
    });
  }

  navItems.push(
    {
      id: "nav-lab",
      category: "navigation",
      title: "طلبات المختبر والتركيبات",
      subtitle: "متابعة أعمال المعمل ومواعيد التسليم",
      icon: "flask",
      onSelect: () => handleNavigate("/lab"),
    },
    {
      id: "nav-inventory",
      category: "navigation",
      title: "مخزون المواد والمستلزمات",
      subtitle: "تتبع الأرصدة وتنبيهات النواقص",
      icon: "box",
      onSelect: () => handleNavigate("/inventory"),
    },
    {
      id: "nav-recall",
      category: "navigation",
      title: "المتابعة والمراجعات الدورية",
      subtitle: "تنبيهات مرضى المتابعة والتقويم",
      icon: "phone",
      onSelect: () => handleNavigate("/recall"),
    },
    {
      id: "nav-requests",
      category: "navigation",
      title: "طلبات الحجز الإلكتروني",
      subtitle: "حجوزات المرضى الواردة عبر البوابة",
      icon: "inbox",
      onSelect: () => handleNavigate("/requests"),
    },
    {
      id: "nav-report",
      category: "navigation",
      title: "التقرير التشغيلي والمالي",
      subtitle: "مؤشرات الأداء اليومي والشامل",
      icon: "chart",
      onSelect: () => handleNavigate("/report"),
    },
  );

  if (isAdmin(session?.role)) {
    navItems.push(
      {
        id: "nav-executive",
        category: "navigation",
        title: "لوحة القيادة الإدارية",
        subtitle: "التحليلات والمؤشرات الإستراتيجية للمركز",
        icon: "crown",
        onSelect: () => handleNavigate("/executive"),
      },
      {
        id: "nav-settings",
        category: "navigation",
        title: "إعدادات المركز والعيادة",
        subtitle: "تخصيص البيانات، الأطباء، والخدمات",
        icon: "settings",
        onSelect: () => handleNavigate("/settings"),
      },
    );
  }

  const actionItems: CommandItem[] = [
    {
      id: "action-new-appointment",
      category: "actions",
      title: "حجز موعد جديد سريع",
      subtitle: "تحديد المريض، نوع الإجراء، والوقت",
      icon: "calendar",
      badge: "Alt + N",
      badgeClass: "border-navy-200 bg-navy-50 text-navy-800 font-mono text-[10px]",
      onSelect: () => {
        onClose();
        onOpenNewAppointment();
      },
    },
    {
      id: "action-new-patient",
      category: "actions",
      title: "تسجيل ملف مريض جديد",
      subtitle: "إضافة مريض جديد بكافة التفاصيل والتنبيهات الطبية",
      icon: "user",
      badge: "Alt + P",
      badgeClass: "border-brand-orange/30 bg-orange-50 text-orange-800 font-mono text-[10px]",
      onSelect: () => {
        onClose();
        onOpenNewPatient();
      },
    },
  ];

  const patientItems: CommandItem[] = patientResults.map((patient) => ({
    id: `patient-${patient.id}`,
    category: "patients",
    title: patient.fullName,
    subtitle: `ملف: ${patient.patientNumber} ${patient.phone ? `· ${patient.phone}` : ""}`,
    icon: "user",
    badge: patient.medicalAlert ? `⚠️ ${patient.medicalAlert}` : `ملف #${patient.patientNumber}`,
    badgeClass: patient.medicalAlert
      ? "border-red-200 bg-red-50 text-red-700 font-bold text-[10px]"
      : "border-slate-200 bg-slate-100 text-slate-700 text-[10px]",
    onSelect: () => handleNavigate(`/patients/${patient.id}`),
  }));

  const filteredNavItems = query.trim()
    ? navItems.filter((item) =>
        item.title.toLowerCase().includes(query.toLowerCase().trim()) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(query.toLowerCase().trim()))
      )
    : navItems;

  const allItems: CommandItem[] = [
    ...patientItems,
    ...(query.trim().length === 0 ? actionItems : []),
    ...filteredNavItems,
  ];

  const activeItem = allItems[selectedIndex] ?? allItems[0];
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeItem?.id, isOpen]);

  if (!isOpen) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, allItems.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + allItems.length) % Math.max(1, allItems.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const current = activeItem;
      if (current) current.onSelect();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <Modal onClose={onClose} label="البحث السريع" initialFocus="input" alignTop>
      <div className="w-full max-w-2xl max-h-[calc(100dvh-2rem)] sm:max-h-[calc(100dvh-5rem)] flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl transition-all">
        {/* حقل البحث الرئيسي */}
        <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3.5 bg-slate-50/50">
          <Icon name="search" className="h-5 w-5 text-slate-600 shrink-0" />
          <input
            ref={inputRef}
            role="combobox"
            aria-label="ابحث عن مريض أو شاشة"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={`${searchId}-results`}
            aria-activedescendant={activeItem ? `${searchId}-${activeItem.id}` : undefined}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="ابحث عن مريض (الاسم، الجوال، رقم الملف) أو انتقل لأي شاشة..."
            className="w-full bg-transparent text-sm font-bold text-navy-900 outline-none placeholder:text-slate-600 placeholder:font-medium"
          />
          <button type="button" onClick={onClose} aria-label="إغلاق البحث" className="shrink-0 rounded-lg p-2 text-slate-600 hover:bg-slate-100">
            <Icon name="close" className="h-4 w-4" />
          </button>
          {searching ? (
            <span className="text-xs text-slate-600 animate-pulse font-medium">جاري البحث…</span>
          ) : (
            <kbd className="hidden sm:inline-block rounded-md border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-500 shadow-2xs">
              ESC للإغلاق
            </kbd>
          )}
        </div>

        {/* قائمة النتائج والأوامر */}
        <div ref={listRef} id={`${searchId}-results`} role="listbox" aria-label="نتائج البحث والإجراءات" aria-busy={searching} className="min-h-0 max-h-[60vh] overflow-y-auto p-2 space-y-3 divide-y divide-slate-100">
          {/* قسم نتائج المرضى إن وجدت */}
          {patientItems.length > 0 && (
            <div className="pt-1">
              <div className="px-3 py-1 text-[11px] font-extrabold text-navy-800 tracking-wider">
                👤 المرضى المطابقون ({patientItems.length})
              </div>
              <div className="mt-1 space-y-0.5">
                {patientItems.map((item) => {
                  const isHighlighted = activeItem?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      id={`${searchId}-${item.id}`}
                      role="option"
                      aria-selected={isHighlighted}
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      type="button"
                      onClick={item.onSelect}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-right transition-colors ${
                        isHighlighted
                          ? "bg-navy-900 text-white"
                          : "hover:bg-slate-100 text-slate-800"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                            isHighlighted ? "bg-white/10 text-white" : "bg-navy-50 text-navy-800"
                          }`}
                        >
                          <Icon name={item.icon} className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-bold">{item.title}</div>
                          {item.subtitle && (
                            <div
                              className={`truncate text-[11px] ${
                                isHighlighted ? "text-slate-300" : "text-slate-500"
                              }`}
                            >
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                      </div>
                      {item.badge && (
                        <span
                          className={`rounded-lg border px-2 py-0.5 truncate max-w-[160px] ${
                            isHighlighted
                              ? "border-white/20 bg-white/10 text-white"
                              : item.badgeClass
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* قسم الإجراءات السريعة */}
          {query.trim().length === 0 && (
            <div className="pt-2">
              <div className="px-3 py-1 text-[11px] font-extrabold text-slate-500 tracking-wider">
                ⚡ إجراءات سريعة
              </div>
              <div className="mt-1 space-y-0.5">
                {actionItems.map((item) => {
                  const isHighlighted = activeItem?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      id={`${searchId}-${item.id}`}
                      role="option"
                      aria-selected={isHighlighted}
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      type="button"
                      onClick={item.onSelect}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-right transition-colors ${
                        isHighlighted
                          ? "bg-navy-900 text-white"
                          : "hover:bg-slate-100 text-slate-800"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                            isHighlighted ? "bg-white/10 text-white" : "bg-orange-50 text-orange-800"
                          }`}
                        >
                          <Icon name={item.icon} className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-bold">{item.title}</div>
                          {item.subtitle && (
                            <div
                              className={`truncate text-[11px] ${
                                isHighlighted ? "text-slate-300" : "text-slate-500"
                              }`}
                            >
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                      </div>
                      {item.badge && (
                        <span
                          className={`rounded-lg border px-2 py-0.5 ${
                            isHighlighted
                              ? "border-white/20 bg-white/10 text-white"
                              : item.badgeClass
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* قسم التنقل والشاشات */}
          {filteredNavItems.length > 0 && (
            <div className="pt-2">
              <div className="px-3 py-1 text-[11px] font-extrabold text-slate-500 tracking-wider">
                🧭 شاشات ووحدات النظام
              </div>
              <div className="mt-1 space-y-0.5">
                {filteredNavItems.map((item) => {
                  const isHighlighted = activeItem?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      id={`${searchId}-${item.id}`}
                      role="option"
                      aria-selected={isHighlighted}
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      type="button"
                      onClick={item.onSelect}
                      className={`flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-right transition-colors ${
                        isHighlighted
                          ? "bg-navy-900 text-white"
                          : "hover:bg-slate-100 text-slate-800"
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span
                          className={`flex h-8 w-8 items-center justify-center rounded-lg ${
                            isHighlighted ? "bg-white/10 text-white" : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          <Icon name={item.icon} className="h-4 w-4" />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate text-xs font-bold">{item.title}</div>
                          {item.subtitle && (
                            <div
                              className={`truncate text-[11px] ${
                                isHighlighted ? "text-slate-300" : "text-slate-500"
                              }`}
                            >
                              {item.subtitle}
                            </div>
                          )}
                        </div>
                      </div>
                      <Icon name="arrow" className={`h-4 w-4 ${isHighlighted ? "text-white" : "text-slate-600"}`} />
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {allItems.length === 0 && (
            <div className="p-8 text-center">
              <p className="text-sm font-bold text-slate-600">لا توجد نتائج مطابقة لـ &quot;{query}&quot;</p>
              <p className="mt-1 text-xs text-slate-600">تأكد من كتابة الاسم أو رقم الملف أو الجوال بشكل صحيح</p>
            </div>
          )}
        </div>

        {/* الشريط السفلي لإرشادات الاختصارات */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50 px-4 py-2 text-[11px] font-semibold text-slate-500">
          <div className="flex items-center gap-3">
            <span>↑↓ للتنقل</span>
            <span>↵ للفتح</span>
            <span>ESC للإغلاق</span>
          </div>
          <div className="text-slate-600">{clinicName}</div>
        </div>
      </div>
    </Modal>
  );
}

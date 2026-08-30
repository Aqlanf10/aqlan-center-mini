"use client";

import { Icon } from "./Icon";

interface ShortcutsHelpModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function ShortcutsHelpModal({ isOpen, onClose }: ShortcutsHelpModalProps) {
  if (!isOpen) return null;

  const SHORTCUT_GROUPS = [
    {
      title: "🔍 البحث والتنقل السريع",
      items: [
        { keys: ["⌘ / Ctrl", "K"], desc: "فتح شريط الأوامر والبحث الفوري الشامل عن المرضى والشاشات" },
        { keys: ["?"], desc: "إظهار دليل اختصارات لوحة المفاتيح هذا" },
        { keys: ["Esc"], desc: "إغلاق أي نافذة منبثقة أو قائمة منسدلة فوراً" },
      ],
    },
    {
      title: "⚡ الإجراءات الفورية",
      items: [
        { keys: ["Alt", "N"], desc: "حجز موعد سريع لمريض (New Appointment)" },
        { keys: ["Alt", "P"], desc: "تسجيل ملف مريض جديد (New Patient)" },
        { keys: ["Ctrl", "P"], desc: "طباعة السند / الفاتورة / الوصفة الطبية" },
      ],
    },
    {
      title: "🧭 شاشات ووحدات النظام الرئيسية",
      items: [
        { keys: ["الاستقبال"], desc: "إدارة طابور اليوم ونداء المرضى للكراسي والشاشة" },
        { keys: ["المواعيد"], desc: "جدول المواعيد الزمني وفحص التعارض وسجل الحجوزات" },
        { keys: ["المرضى"], desc: "الملفات السريرية، المخطط السني، الخطط العلاجية والروشتات" },
        { keys: ["الصندوق"], desc: "سندات القبض والصرف، فواتير العلاج وكشوفات الحساب" },
        { keys: ["المعمل"], desc: "متابعة التركيبات السنية وأوامر المعامل الخارجية والتكاليف" },
        { keys: ["المخزن"], desc: "مراقبة المخزون، تواريخ الصلاحية، الجرد وتكاليف المستهلكات" },
        { keys: ["شاشة الصالة"], desc: "شاشة التلفزيون لعرض أسماء المرضى المنادى عليهم برقم الكرسي والصوت" },
      ],
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="fixed inset-0" onClick={onClose} />
      <div className="relative z-10 flex flex-col max-h-[85vh] w-full max-w-2xl rounded-3xl bg-white shadow-2xl border border-slate-200 overflow-hidden">
        {/* الرأس */}
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/80 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-navy-100 text-brand-navy text-lg font-bold">
              ⌨️
            </div>
            <div>
              <h2 className="text-base font-black text-navy-900">
                دليل اختصارات وسرعة الاستخدام
              </h2>
              <p className="text-xs text-slate-500 font-medium">
                تحكم كامل وسريع بالنظام من لوحة المفاتيح لإنجاز العمل اليومي
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 hover:bg-slate-200 hover:text-slate-700 transition-colors"
          >
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>

        {/* المحتوى */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {SHORTCUT_GROUPS.map((group, gIdx) => (
            <div key={gIdx} className="space-y-3">
              <h3 className="text-xs font-black text-slate-700 border-b border-slate-100 pb-1.5">
                {group.title}
              </h3>
              <div className="grid grid-cols-1 gap-2">
                {group.items.map((item, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50/70 p-2.5 text-xs hover:bg-slate-100/80 transition-colors"
                  >
                    <span className="font-medium text-slate-700">{item.desc}</span>
                    <div className="flex items-center gap-1 shrink-0" dir="ltr">
                      {item.keys.map((k, kIdx) => (
                        <kbd
                          key={kIdx}
                          className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-[11px] font-bold text-navy-900 shadow-2xs font-mono"
                        >
                          {k}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* التذييل */}
        <div className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-6 py-3.5">
          <span className="text-xs text-slate-500">
            💡 نصيحة: يمكنك استدعاء هذا الدليل في أي وقت بالضغط على زر <kbd className="px-1.5 py-0.5 rounded border border-slate-300 bg-white font-mono text-[10px]">?</kbd>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-brand-navy px-4 py-1.5 text-xs font-bold text-white hover:bg-navy-900"
          >
            حسناً، فهمت
          </button>
        </div>
      </div>
    </div>
  );
}

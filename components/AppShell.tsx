"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useClinicName } from "./SettingsProvider";
import { useSessionActions } from "./SessionProvider";
import { canHandleMoney, isAdmin, ROLE_LABEL, type Role } from "@/lib/roles";
import { Icon, Logo, type IconName } from "./Icon";
import LoginPage from "@/app/login/page";
import { GlobalSearchModal } from "./GlobalSearchModal";
import { QuickAppointmentModal } from "./QuickAppointmentModal";
import { QuickPatientModal } from "./QuickPatientModal";
import { ShortcutsHelpModal } from "./ShortcutsHelpModal";
import { playNewMessageChime, playUrgentChime } from "./Chat";

/**
 * قشرة البرنامج — تنقّل واحد لكل الشاشات مع شريط علوي ذكي وإجراءات سريعة عالمية.
 */

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: "requests" | "lab" | "messages";
  /** من يرى هذا الرابط. الغياب يعني الجميع. */
  needs?: "money" | "admin" | "doctor";
}

const NAV: NavItem[] = [
  { href: "/", label: "اليوم", icon: "tooth" },
  { href: "/appointments", label: "المواعيد", icon: "calendar" },
  { href: "/patients", label: "المرضى", icon: "user" },
  { href: "/messages", label: "الرسائل", icon: "chat", badge: "messages" },
  { href: "/finance", label: "الصندوق", icon: "wallet", needs: "money" },
  /* مستحقاتي (صلاحيات الوكيل المساعد): بوابة الطبيب إلى عمولاته الشخصية —
     يراها الأطباء وحدهم، والشاشة نفسها تحجب مالية المركز ما لم يصرّح المدير. */
  { href: "/finance/commissions", label: "مستحقاتي", icon: "wallet", needs: "doctor" },
  { href: "/lab", label: "المختبر", icon: "flask", badge: "lab" },
  { href: "/inventory", label: "المخزون", icon: "box" },
  { href: "/recall", label: "المتابعة", icon: "phone" },
  { href: "/requests", label: "الطلبات", icon: "inbox", badge: "requests" },
  { href: "/report", label: "تقرير اليوم", icon: "clock" },
  { href: "/reports", label: "التقارير", icon: "chart", needs: "money" },
  { href: "/executive", label: "القيادة", icon: "crown", needs: "admin" },
  { href: "/settings", label: "الإعدادات", icon: "settings", needs: "admin" },
];

/**
 * الشاشات التي لا قشرة لها: عامة، أو تُعرض على تلفاز، أو قبل الدخول، أو تُطبع.
 */
const BARE_PATHS = ["/login", "/setup", "/display", "/book", "/print", "/portal"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const clinicName = useClinicName();
  const { session, logout } = useSessionActions();

  const nav = NAV.filter((item) => {
    if (item.needs === "admin") return isAdmin(session?.role);
    if (item.needs === "money") return canHandleMoney(session?.role);
    if (item.needs === "doctor") return session?.role === "doctor";
    return true;
  });
  const [badges, setBadges] = useState<{ requests: number; lab: number; messages: number; urgentMessages: number }>({
    requests: 0, lab: 0, messages: 0, urgentMessages: 0,
  });
  const prevMessagesBadgeRef = useRef<number | null>(null);
  const prevUrgentBadgeRef = useRef<number | null>(null);
  // إخفاء البانر الأحمر: يبقى مخفيًا ما دام صاحبه عارفًا به، ويعود مسلّحًا
  // متى نزل العدد إلى الصفر — أي فتح أحدهم الرسائل فقرأ العاجلة — ثم وردت
  // عاجلة جديدة. مقاطعة من يعرف لا تنبيه، والمعلومة الجديدة تستحق الصراخ.
  const [urgentDismissed, setUrgentDismissed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [quickMenuOpen, setQuickMenuOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // نوافذ الإجراءات السريعة العالمية
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [appointmentModalOpen, setAppointmentModalOpen] = useState(false);
  const [patientModalOpen, setPatientModalOpen] = useState(false);

  // ساعة وتاريخ لحظي
  const [clock, setClock] = useState({ date: "", time: "" });

  const bare = BARE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  const loadBadges = useCallback(async () => {
    try {
      const [requests, lab, messages] = await Promise.all([
        fetch("/api/booking-requests?status=new", { cache: "no-store" }),
        fetch("/api/lab?summary=1", { cache: "no-store"}),
        fetch("/api/messages?unread=1", { cache: "no-store" }),
      ]);
      const next = { requests: 0, lab: 0, messages: 0, urgentMessages: 0 };
      if (requests.ok) next.requests = ((await requests.json()) as unknown[]).length;
      if (lab.ok) next.lab = Number(((await lab.json()) as { late?: number }).late ?? 0);
      if (messages.ok) {
        const payload = (await messages.json()) as { unread?: number; urgent?: number };
        next.messages = Number(payload.unread ?? 0);
        next.urgentMessages = Number(payload.urgent ?? 0);
      }
      // نغمة الرسالة الجديدة: عند ارتفاع غير المقروء فقط لا عند أول تحميل — فمن
      // يفتح البرنامج على رسائل قديمة لا يُفاجأ بنغمة، ومن تصله رسالة وهو في
      // شاشةٍ أخرى يسمعها. والرسالة العاجلة لها نغمة الاستغاثة — ثلاث دقّات
      // عالية لا نقرتين مهذبتين.
      const prev = prevMessagesBadgeRef.current;
      const prevUrgent = prevUrgentBadgeRef.current;
      if (prevUrgent !== null && next.urgentMessages > prevUrgent) {
        playUrgentChime();
      } else if (prev !== null && next.messages > prev) {
        playNewMessageChime();
      }
      prevMessagesBadgeRef.current = next.messages;
      prevUrgentBadgeRef.current = next.urgentMessages;
      setBadges(next);
    } catch {
      // العدّادات تبقى على آخر قيمة
    }
  }, []);

  // تحديث الساعة والتاريخ
  useEffect(() => {
    const updateTime = () => {
      const d = new Date();
      const options: Intl.DateTimeFormatOptions = {
        weekday: "short",
        month: "short",
        day: "numeric",
      };
      setClock({
        date: d.toLocaleDateString("ar-YE", options),
        time: d.toLocaleTimeString("ar-YE", { hour: "2-digit", minute: "2-digit", hour12: true }),
      });
    };
    updateTime();
    const interval = setInterval(updateTime, 30_000);
    return () => clearInterval(interval);
  }, []);

  // إغلاق القوائم عند الانتقال
  useEffect(() => {
    setMoreOpen(false);
    setQuickMenuOpen(false);
  }, [pathname]);

  // مستمع اختصارات لوحة المفاتيح السريعة العالمية
  useEffect(() => {
    if (bare || !session) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // ⌘K أو Ctrl+K للبحث السريع
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setSearchModalOpen((prev) => !prev);
      }
      // Alt+N لموعد جديد
      if (e.altKey && (e.key === "n" || e.key === "N" || e.key === "ى")) {
        e.preventDefault();
        setAppointmentModalOpen(true);
      }
      // Alt+P لمريض جديد
      if (e.altKey && (e.key === "p" || e.key === "P" || e.key === "ح")) {
        e.preventDefault();
        setPatientModalOpen(true);
      }
      // ? دليل الاختصارات — ما دام المؤشر خارج حقل كتابة
      if (e.key === "?" || (e.shiftKey && e.key === "؟")) {
        const target = e.target as HTMLElement | null;
        const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA"
          || target?.isContentEditable;
        if (!typing) {
          e.preventDefault();
          setShortcutsOpen(true);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [bare, session]);

  useEffect(() => {
    if (bare || !session) return;
    void loadBadges();
    const timer = setInterval(() => { void loadBadges(); }, 60_000);
    return () => clearInterval(timer);
  }, [bare, session, loadBadges]);

  // عودة سلاح البانر: نزول العاجلة إلى الصفر يعني أن أحدهم فتحها وقرأها.
  useEffect(() => {
    if (badges.urgentMessages === 0 && urgentDismissed) setUrgentDismissed(false);
  }, [badges.urgentMessages, urgentDismissed]);

  const showUrgentBanner = badges.urgentMessages > 0 && !urgentDismissed;

  if (bare) return <>{children}</>;

  if (!session) {
    return <LoginPage />;
  }

  const signOut = async () => {
    await logout();
  };

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  const restActive = nav.slice(4).some((item) => isActive(item.href));

  return (
    <div className="min-h-full lg:flex">
      {/* القائمة الجانبية للشاشات الكبيرة */}
      <aside className="hidden w-60 shrink-0 border-l border-slate-200 bg-white lg:flex lg:flex-col">
        <div className="flex items-start gap-2.5 border-b border-slate-100 p-4">
          <Logo className="mt-0.5 h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <p className="text-[13px] font-bold leading-tight text-navy-900">{clinicName}</p>
            <p className="mt-0.5 text-[10px] font-semibold text-slate-400">نظام إدارة المركز الطبي</p>
          </div>
        </div>
        <nav className="flex-1 space-y-0.5 p-3">
          {nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={`flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold transition-colors ${
                isActive(item.href)
                  ? "bg-navy-900 text-white shadow-card"
                  : "text-slate-600 hover:bg-navy-50 hover:text-navy-900"
              }`}
            >
              <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
              <span className="flex-1">{item.label}</span>
              <Badge item={item} badges={badges} />
            </a>
          ))}
        </nav>
        <div className="space-y-0.5 border-t border-slate-100 p-3">
          <a href="/display" target="_blank" rel="noopener"
            className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50">
            <Icon name="screen" className="h-4 w-4 shrink-0" /> شاشة الصالة
          </a>
          <a href="/book" target="_blank" rel="noopener"
            className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-50">
            <Icon name="link" className="h-4 w-4 shrink-0" /> صفحة حجز المرضى
          </a>
        </div>

        {session ? (
          <div className="border-t border-slate-100 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-100 text-[11px] font-bold text-navy-800">
                {session.username.slice(0, 2)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-navy-900">{session.displayName || session.username}</p>
                <p className="text-[10px] font-semibold text-slate-400">
                  {ROLE_LABEL[session.role as Role] ?? session.role}
                </p>
              </div>
              <a href="/login" aria-label="شاشة الدخول"
                className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="تبديل الحساب / تسجيل الدخول">
                <Icon name="logout" className="h-4 w-4" />
              </a>
            </div>
          </div>
        ) : null}
      </aside>

      <div className="flex-1 pb-20 lg:pb-0 flex flex-col min-w-0">
        {/* بانر الرسائل العاجلة — ألم مريض لا ينتظر دور الشارة */}
        {showUrgentBanner && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2.5 border-b border-danger-700 bg-danger-600 px-4 py-2 text-white sm:gap-3"
          >
            <span className="relative flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden="true">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white/50 opacity-75" />
              <Icon name="alert" className="relative h-4 w-4" />
            </span>
            <p className="min-w-0 flex-1 text-xs font-black sm:text-sm">
              رسالة عاجلة من مريض تنتظر الرد — عدد الرسائل العاجلة غير المقروءة: {badges.urgentMessages}
            </p>
            <a
              href="/messages"
              className="shrink-0 rounded-xl bg-white px-3.5 py-1.5 text-xs font-black text-danger-700 transition-colors hover:bg-danger-50"
            >
              فتح الرسائل
            </a>
            <button
              type="button"
              onClick={() => setUrgentDismissed(true)}
              aria-label="إخفاء التنبيه"
              className="shrink-0 rounded-xl p-1.5 text-white/80 transition-colors hover:bg-danger-700 hover:text-white"
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
          </div>
        )}
        {/* شريط علوي موحد للشاشات الكبيرة (Desktop & Tablet Header Bar) */}
        <header className="hidden lg:flex items-center justify-between gap-4 border-b border-slate-200 bg-white/80 px-6 py-2.5 backdrop-blur-md sticky top-0 z-30">
          {/* زر البحث الفوري الشامل */}
          <button
            type="button"
            onClick={() => setSearchModalOpen(true)}
            className="flex items-center gap-3 rounded-xl border border-slate-200 bg-slate-50/80 px-3.5 py-1.5 text-xs text-slate-500 hover:border-navy-300 hover:bg-white hover:text-navy-900 transition-all w-80 max-w-sm"
          >
            <Icon name="search" className="h-4 w-4 text-slate-400" />
            <span className="flex-1 text-right font-medium">بحث عن مريض أو شاشة...</span>
            <kbd className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-bold text-slate-600 shadow-2xs">
              ⌘K
            </kbd>
          </button>

          {/* الوقت والإجراء السريع وحالة الحساب */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShortcutsOpen(true)}
              aria-label="دليل اختصارات لوحة المفاتيح"
              title="دليل الاختصارات (?)"
              className="flex items-center rounded-xl border border-slate-200 bg-slate-50/80 px-2.5 py-1.5 text-xs font-bold text-slate-500 transition-colors hover:border-navy-300 hover:bg-white hover:text-navy-900"
            >
              <kbd className="font-mono text-[10px] font-black">?</kbd>
            </button>
            {clock.date && (
              <div className="flex items-center gap-1.5 rounded-xl bg-slate-50 border border-slate-100 px-3 py-1 text-xs font-bold text-slate-600">
                <Icon name="clock" className="h-3.5 w-3.5 text-slate-400" />
                <span>{clock.date}</span>
                <span className="text-slate-300">·</span>
                <span className="text-navy-900">{clock.time}</span>
              </div>
            )}

            {/* قائمة الإجراءات السريعة المنسدلة */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setQuickMenuOpen((prev) => !prev)}
                className="flex items-center gap-1.5 rounded-xl bg-brand-orange px-3.5 py-1.5 text-xs font-black text-white shadow-xs hover:bg-orange-600 transition-colors"
              >
                <Icon name="plus" className="h-3.5 w-3.5" />
                <span>إجراء سريع</span>
              </button>

              {quickMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setQuickMenuOpen(false)}
                  />
                  <div className="absolute left-0 mt-2 w-56 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl z-50 animate-in fade-in zoom-in-95 duration-100">
                    <button
                      type="button"
                      onClick={() => {
                        setQuickMenuOpen(false);
                        setAppointmentModalOpen(true);
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-right text-xs font-bold text-slate-700 hover:bg-navy-50 hover:text-navy-900"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-navy-700">📅</span>
                        <span>حجز موعد سريع</span>
                      </div>
                      <kbd className="text-[10px] text-slate-400 font-mono">Alt+N</kbd>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setQuickMenuOpen(false);
                        setPatientModalOpen(true);
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-2 text-right text-xs font-bold text-slate-700 hover:bg-orange-50 hover:text-orange-900"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-orange-600">👤</span>
                        <span>تسجيل مريض جديد</span>
                      </div>
                      <kbd className="text-[10px] text-slate-400 font-mono">Alt+P</kbd>
                    </button>
                    {canHandleMoney(session?.role) && (
                      <button
                        type="button"
                        onClick={() => {
                          setQuickMenuOpen(false);
                          router.push("/finance");
                        }}
                        className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-right text-xs font-bold text-slate-700 hover:bg-emerald-50 hover:text-emerald-900"
                      >
                        <span>🧾</span>
                        <span>تسجيل سند مالي / قبض</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        setQuickMenuOpen(false);
                        router.push("/lab");
                      }}
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-right text-xs font-bold text-slate-700 hover:bg-purple-50 hover:text-purple-900"
                    >
                      <span>🧪</span>
                      <span>طلب معمل وتركيبات</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </header>

        {/* شريط الهاتف */}
        <div className="flex items-center gap-2.5 border-b border-slate-200 bg-white px-3 py-2 lg:hidden sticky top-0 z-30">
          <Logo className="h-7 w-7 shrink-0" />
          <span className="line-clamp-2 flex-1 text-[11px] font-bold leading-tight text-navy-900">
            {clinicName}
          </span>
          <button
            onClick={() => setSearchModalOpen(true)}
            aria-label="بحث سريع"
            className="shrink-0 rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"
          >
            <Icon name="search" className="h-4 w-4" />
          </button>
          <button
            onClick={signOut}
            aria-label="خروج"
            className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
          >
            <Icon name="logout" className="h-4 w-4" />
          </button>
        </div>

        <main className="flex-1">{children}</main>
      </div>

      {/* النوافذ العائمة العالمية */}
      <GlobalSearchModal
        isOpen={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        onOpenNewAppointment={() => setAppointmentModalOpen(true)}
        onOpenNewPatient={() => setPatientModalOpen(true)}
      />

      <QuickAppointmentModal
        isOpen={appointmentModalOpen}
        onClose={() => setAppointmentModalOpen(false)}
        onSuccess={() => {
          setAppointmentModalOpen(false);
          if (pathname === "/appointments") {
            window.location.reload();
          }
        }}
      />

      <QuickPatientModal
        isOpen={patientModalOpen}
        onClose={() => setPatientModalOpen(false)}
        onSuccess={(patient) => {
          setPatientModalOpen(false);
          router.push(`/patients/${patient.id}`);
        }}
      />

      <ShortcutsHelpModal
        isOpen={shortcutsOpen}
        onClose={() => setShortcutsOpen(false)}
      />

      {/* شريط سفلي على الهاتف */}
      {moreOpen ? (
        <button
          aria-label="إغلاق القائمة"
          onClick={() => setMoreOpen(false)}
          className="fixed inset-0 z-20 bg-navy-900/20 lg:hidden"
        />
      ) : null}

      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white/95 backdrop-blur lg:hidden">
        {moreOpen ? (
          <div className="border-b border-slate-100 p-2">
            {nav.slice(4).map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-700"
              >
                <Icon name={item.icon} className="h-[18px] w-[18px] shrink-0" />
                <span className="flex-1">{item.label}</span>
                <Badge item={item} badges={badges} />
              </a>
            ))}
            <a href="/display" target="_blank" rel="noopener"
              className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500">
              <Icon name="screen" className="h-[18px] w-[18px] shrink-0" /> شاشة الصالة
            </a>
            <a href="/book" target="_blank" rel="noopener"
              className="flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold text-slate-500">
              <Icon name="link" className="h-[18px] w-[18px] shrink-0" /> صفحة حجز المرضى
            </a>
          </div>
        ) : null}

        <div className="flex justify-around">
          {nav.slice(0, 4).map((item) => (
            <a
              key={item.href}
              href={item.href}
              aria-current={isActive(item.href) ? "page" : undefined}
              className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-bold ${
                isActive(item.href) ? "text-navy-900" : "text-slate-400"
              }`}
            >
              <Icon name={item.icon} className="h-5 w-5" />
              {item.label}
              <Badge item={item} badges={badges} floating />
            </a>
          ))}
          <button
            onClick={() => setMoreOpen((open) => !open)}
            aria-expanded={moreOpen}
            className={`relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-bold ${
              moreOpen || restActive ? "text-navy-900" : "text-slate-400"
            }`}
          >
            <Icon name="menu" className="h-5 w-5" />
            المزيد
            {!moreOpen && badges.requests > 0 ? (
              <span className="absolute -top-0.5 left-1/4 rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
                {badges.requests}
              </span>
            ) : null}
          </button>
        </div>
      </nav>
    </div>
  );
}

function Badge({ item, badges, floating = false }: {
  item: NavItem;
  badges: { requests: number; lab: number; messages: number; urgentMessages: number };
  floating?: boolean;
}) {
  if (!item.badge) return null;
  const count = badges[item.badge];
  if (!count) return null;
  // شارة الرسائل تحمرّ وتنبض ما دامت عاجلة غير مقروءة — لون واحد للجميع:
  // البرتقالي «عندك رسائل»، والأحمر «عندك مريض يستغيث».
  const urgent = item.badge === "messages" && badges.urgentMessages > 0;
  return (
    <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold text-white ${
      urgent ? "animate-pulse bg-danger-600" : "bg-accent-500"
    } ${floating ? "absolute -top-0.5 left-1/4" : ""}`}>
      {count}
    </span>
  );
}

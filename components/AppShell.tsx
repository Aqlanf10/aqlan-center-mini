"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useClinicName } from "./SettingsProvider";
import { useSession } from "./SessionProvider";
import { canHandleMoney, isAdmin, ROLE_LABEL, type Role } from "@/lib/roles";
import { Icon, Logo, type IconName } from "./Icon";

/**
 * قشرة البرنامج — تنقّل واحد لكل الشاشات.
 *
 * كانت كل صفحة تحمل صفّ روابطها الخاص، فاختلفت الروابط بين الشاشات وضاع «أين أنا»،
 * وكل وحدة جديدة كانت تعني تعديل ست صفحات. الآن: قائمة واحدة، والصفحة تعرف مكانها
 * منها.
 *
 * الشكل يتبع الجهاز لا العكس: الاستقبال على هاتف طول اليوم فالتنقّل شريط سفلي يُطال
 * بالإبهام؛ والطبيب على شاشة مكتب فالتنقّل عمود جانبي دائم. وهما نفس القائمة.
 */

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  badge?: "requests" | "lab";
  /** من يرى هذا الرابط. الغياب يعني الجميع. */
  needs?: "money" | "admin";
}

const NAV: NavItem[] = [
  { href: "/", label: "اليوم", icon: "tooth" },
  { href: "/appointments", label: "المواعيد", icon: "calendar" },
  { href: "/patients", label: "المرضى", icon: "user" },
  { href: "/finance", label: "الصندوق", icon: "wallet", needs: "money" },
  { href: "/lab", label: "المختبر", icon: "flask", badge: "lab" },
  { href: "/inventory", label: "المخزون", icon: "box" },
  { href: "/recall", label: "المتابعة", icon: "phone" },
  { href: "/requests", label: "الطلبات", icon: "inbox", badge: "requests" },
  { href: "/report", label: "التقرير", icon: "chart" },
  { href: "/executive", label: "القيادة", icon: "crown", needs: "admin" },
  { href: "/settings", label: "الإعدادات", icon: "settings", needs: "admin" },
];

/**
 * الشاشات التي لا قشرة لها: عامة، أو تُعرض على تلفاز، أو قبل الدخول، أو تُطبع.
 *
 * صفحات الطباعة أهمّها هنا: قائمة جانبية وشريط سفلي على ورقة سندٍ يُعطى لمريض.
 */
const BARE_PATHS = ["/login", "/setup", "/display", "/book", "/print", "/portal"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const clinicName = useClinicName();
  const session = useSession();

  // القائمة تُبنى مما يستطيع صاحبها فعله: قائمةٌ نصفها يعطي «ممنوع» تُعلّم المستخدم
  // ألّا يثق بها.
  const nav = NAV.filter((item) =>
    item.needs === "admin" ? isAdmin(session?.role)
      : item.needs === "money" ? canHandleMoney(session?.role)
      : true);
  const [badges, setBadges] = useState<{ requests: number; lab: number }>({ requests: 0, lab: 0 });
  const [moreOpen, setMoreOpen] = useState(false);

  const bare = BARE_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));

  const loadBadges = useCallback(async () => {
    try {
      const [requests, lab] = await Promise.all([
        fetch("/api/booking-requests?status=new", { cache: "no-store" }),
        fetch("/api/lab?summary=1", { cache: "no-store" }),
      ]);
      const next = { requests: 0, lab: 0 };
      if (requests.ok) next.requests = ((await requests.json()) as unknown[]).length;
      if (lab.ok) next.lab = Number(((await lab.json()) as { late?: number }).late ?? 0);
      setBadges(next);
    } catch {
      // العدّادان يبقيان على آخر قيمة: رقمٌ قديم أنفع من اختفاء التنبيه.
    }
  }, []);

  // القائمة تُغلق مع كل انتقال: بقاؤها مفتوحة فوق الشاشة الجديدة يخفي أعلاها.
  useEffect(() => { setMoreOpen(false); }, [pathname]);

  useEffect(() => {
    if (bare) return;
    void loadBadges();
    // دقيقة كافية: هذه تنبيهات لا أرقام تشغيل لحظية، وطلبها كل عشرين ثانية من كل
    // شاشة كان يضاعف الطلبات بلا فائدة.
    const timer = setInterval(() => { void loadBadges(); }, 60_000);
    return () => clearInterval(timer);
  }, [bare, loadBadges]);

  if (bare) return <>{children}</>;

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  // شاشة من الشاشات المخفية خلف «المزيد» مفتوحة الآن — فيُضاء الزر.
  const restActive = nav.slice(4).some((item) => isActive(item.href));

  return (
    <div className="min-h-full lg:flex">
      <aside className="hidden w-60 shrink-0 border-l border-slate-200 bg-white lg:flex lg:flex-col">
        {/* هوية المركز في أعلى كل شاشة: الشعار والاسم الكامل — لا اختصارًا، لأن هذه
            هي واجهة المركز أمام من يعمل فيه ثماني ساعات يوميًا. */}
        <div className="flex items-start gap-2.5 border-b border-slate-100 p-4">
          <Logo className="mt-0.5 h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <p className="text-[13px] font-bold leading-tight text-navy-900">{clinicName}</p>
            <p className="mt-0.5 text-[10px] font-semibold text-slate-400">نظام إدارة المركز</p>
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

        {/* من يستعمل البرنامج الآن: يظهر أسفل القائمة لا فوقها — الشاشة للعمل،
            والهوية تُراجَع عند الحاجة. وزر الخروج بجانبها حيث يُتوقَّع. */}
        {session ? (
          <div className="flex items-center gap-2 border-t border-slate-100 p-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-100 text-[11px] font-bold text-navy-800">
              {session.username.slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-navy-900">{session.username}</p>
              <p className="text-[10px] font-semibold text-slate-400">
                {ROLE_LABEL[session.role as Role] ?? session.role}
              </p>
            </div>
            <button onClick={signOut} aria-label="خروج"
              className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-danger-50 hover:text-danger-700">
              <Icon name="logout" className="h-4 w-4" />
            </button>
          </div>
        ) : null}
      </aside>

      <div className="flex-1 pb-20 lg:pb-0">
        {/* شريط الهاتف: كان الاسم الطويل يُقصّ إلى «…وتجميل ا» بجانب كلمة «خروج»،
            فلا هوية ظهرت ولا زر وُضّح. الشعار يحمل الهوية في مساحة ثابتة، والاسم
            يأخذ سطرين إن احتاج. */}
        <div className="flex items-center gap-2.5 border-b border-slate-200 bg-white px-3 py-2 lg:hidden">
          <Logo className="h-7 w-7 shrink-0" />
          <span className="line-clamp-2 flex-1 text-[11px] font-bold leading-tight text-navy-900">
            {clinicName}
          </span>
          <button onClick={signOut} aria-label="خروج"
            className="shrink-0 rounded-lg p-1.5 text-slate-400">
            <Icon name="logout" className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>

      {/*
        شريط سفلي على الهاتف: الاستقبال تمسك الجهاز بيد واحدة طول اليوم.
        أربع شاشات في الشريط والبقية خلف «المزيد» — وهو زر يفتح قائمة فعلًا، لا رابط
        إلى شاشة واحدة سُمّي «المزيد».
      */}
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
  badges: { requests: number; lab: number };
  floating?: boolean;
}) {
  if (!item.badge) return null;
  const count = badges[item.badge];
  if (!count) return null;
  return (
    <span className={`rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-extrabold text-white ${
      floating ? "absolute -top-0.5 left-1/4" : ""
    }`}>
      {count}
    </span>
  );
}

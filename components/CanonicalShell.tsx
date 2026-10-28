"use client";

import { usePathname, useRouter } from "next/navigation";
import { useClinicName } from "./SettingsProvider";
import { useSessionActions } from "./SessionProvider";
import { Icon, Logo } from "./Icon";
import { ROLE_LABEL, type Role } from "@/lib/roles";
import { canonicalPageFor, canonicalPagesFor } from "@/lib/canonical-navigation";

/**
 * قشرة جلسة الهوية الموحّدة.
 *
 * القائمة إسقاطٌ لقدرات الجلسة الحالية على الشاشات التي نُقلت كاملةً إلى الهوية
 * الموحّدة فقط (lib/canonical-navigation). لا تستدعي أي مسارٍ قديم (عدّادات، بحث،
 * اختصارات)، ولا تعرض شاشةً لم تُنقل بعد: تعرض بدلها مساحة العمل المتاحة.
 * الخادم يقرّر كل عملية بقدرتها الدقيقة؛ ما يُخفى هنا لا يُعدّ حماية.
 */
export function CanonicalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const clinicName = useClinicName();
  const { session, logout } = useSessionActions();
  if (!session) return null;
  const pages = canonicalPagesFor(session.capabilities, session.isOwner);
  const current = canonicalPageFor(pathname);
  const ready = current !== null && pages.includes(current);
  const roleLabel = ROLE_LABEL[session.role as Role] ?? session.role;

  async function signOut() {
    await logout();
    router.replace("/login");
  }

  return (
    <div className="min-h-full lg:flex print:block" data-testid="canonical-shell">
      <aside className="w-full shrink-0 border-b border-slate-200 bg-white lg:w-60 lg:border-b-0 lg:border-l print:hidden">
        <div className="flex items-start gap-2.5 border-b border-slate-100 p-4">
          <Logo className="mt-0.5 h-9 w-9 shrink-0" />
          <div className="min-w-0">
            <p className="text-[13px] font-bold leading-tight text-navy-900">{clinicName}</p>
            <p className="mt-0.5 text-[10px] font-semibold text-slate-600">الهوية الموحّدة للطاقم</p>
          </div>
        </div>
        <nav aria-label="شاشات الهوية الموحّدة" className="flex gap-1 overflow-x-auto p-3 lg:flex-col lg:space-y-0.5">
          <a href="/" aria-current={pathname === "/" ? "page" : undefined}
            className={`flex min-h-11 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 text-sm font-semibold ${pathname === "/" ? "bg-navy-900 text-white" : "text-slate-600 hover:bg-navy-50 hover:text-navy-900"}`}>
            <Icon name="tooth" className="h-[18px] w-[18px] shrink-0" /> مساحة العمل
          </a>
          {pages.map(page => {
            const active = current === page;
            return (
              <a key={page.href} href={page.href} aria-current={active ? "page" : undefined}
                className={`flex min-h-11 items-center gap-2.5 whitespace-nowrap rounded-xl px-3 text-sm font-semibold ${active ? "bg-navy-900 text-white" : "text-slate-600 hover:bg-navy-50 hover:text-navy-900"}`}>
                <Icon name="settings" className="h-[18px] w-[18px] shrink-0" /> {page.label}
              </a>
            );
          })}
        </nav>
        <div className="border-t border-slate-100 p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy-100 text-[11px] font-bold text-navy-800">
              {session.username.slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-navy-900" data-testid="canonical-display-name">{session.displayName || session.username}</p>
              <p className="text-[10px] font-semibold text-slate-600">
                {roleLabel}{session.isOwner ? " — المالك المحمي" : ""}
              </p>
            </div>
            <button type="button" onClick={() => void signOut()} aria-label="تسجيل الخروج"
              className="min-h-11 shrink-0 rounded-lg px-2 text-slate-600 hover:bg-slate-100 hover:text-slate-700" title="تسجيل الخروج">
              <Icon name="logout" className="h-4 w-4" />
            </button>
          </div>
        </div>
      </aside>
      <main dir="rtl" className="min-w-0 flex-1 p-4 lg:p-6">
        {ready ? children : (
          <section aria-labelledby="canonical-workspace-title" className="mx-auto max-w-3xl space-y-4" data-testid="canonical-workspace">
            <h1 id="canonical-workspace-title" className="text-lg font-black text-navy-900">مرحبًا {session.displayName || session.username}</h1>
            {pathname !== "/" ? (
              <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                هذه الشاشة لم تُنقل بعد إلى الهوية الموحّدة، أو لا تملك صلاحيتها. اختر من الشاشات المتاحة أدناه.
              </p>
            ) : null}
            {pages.length ? (
              <ul className="grid gap-3 sm:grid-cols-2">
                {pages.map(page => (
                  <li key={page.href}>
                    <a href={page.href} className="block min-h-11 rounded-2xl border border-slate-200 bg-white p-4 shadow-card hover:border-navy-300">
                      <span className="block text-sm font-bold text-navy-900">{page.label}</span>
                      <span className="mt-1 block text-xs text-slate-600">{page.description}</span>
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p role="note" className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-700">
                لا توجد شاشة متاحة لصلاحياتك الحالية بعد. راجع إدارة المركز.
              </p>
            )}
            <p className="text-xs text-slate-600">بقية شاشات المركز تُنقل إلى الهوية الموحّدة تباعًا؛ ما لم يُنقل بعد لا يظهر هنا.</p>
          </section>
        )}
      </main>
    </div>
  );
}

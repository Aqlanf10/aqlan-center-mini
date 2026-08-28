import { AppHeader } from "@/components/layout/app-header";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { requireUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";
import { getClinicSettingsValues } from "@/server/settings/queries";

/** Authenticated application shell: sidebar + header + main content. */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [user, { dict }, clinic] = await Promise.all([
    requireUser(),
    getI18n(),
    getClinicSettingsValues(),
  ]);
  const brandName = clinic.displayName || dict.app.name;

  return (
    <div className="bg-muted/40 min-h-svh">
      <a
        href="#main-content"
        className="bg-primary text-primary-foreground sr-only z-50 rounded-md px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:start-4 focus:top-4"
      >
        {dict.common.home}
      </a>

      <AppSidebar user={user} brandName={brandName} />

      <div className="flex min-h-svh flex-col lg:ps-64">
        <AppHeader user={user} brandName={brandName} />
        <main
          id="main-content"
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8"
        >
          {children}
        </main>
      </div>
    </div>
  );
}

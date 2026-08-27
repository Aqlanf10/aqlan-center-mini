import { Suspense } from "react";
import { StethoscopeIcon } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { LoginForm } from "@/components/auth/login-form";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { Skeleton } from "@/components/ui/skeleton";
import { getSessionUser } from "@/lib/auth/guards";
import { getI18n } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const { dict } = await getI18n();
  return { title: dict.auth.loginTitle };
}

function LoginFallback() {
  return (
    <div className="flex w-full max-w-sm flex-col gap-4">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export default async function LoginPage() {
  // Real database check (unlike the old edge guess): only bounce to the
  // dashboard when the session is genuinely alive and the account is
  // active. Expired/revoked/deactivated cookies simply show the form —
  // no redirect loop.
  const user = await getSessionUser();
  if (user) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-svh flex-col bg-muted md:flex-row">
      {/* Brand panel */}
      <section className="flex flex-col justify-center gap-6 bg-navy-900 px-6 py-10 text-white md:w-2/5 md:px-12 lg:w-1/2">
        <div className="flex items-center gap-3">
          <span className="flex size-12 items-center justify-center rounded-xl bg-brand-500 text-white shadow-lg">
            <StethoscopeIcon className="size-6" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-bold">Aqlan Center Mini</h1>
            <p className="text-sm text-navy-200">Clinic Operations</p>
          </div>
        </div>
        <div className="max-w-md space-y-3">
          <p className="text-lg font-semibold leading-relaxed">
            مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان
          </p>
          <p className="text-sm leading-relaxed text-navy-200">
            Dr. Aqlan Complete Center for Orthodontics, Implants and Cosmetic
            Dentistry
          </p>
        </div>
        <div className="h-1 w-24 rounded-full bg-brand-500" aria-hidden="true" />
      </section>

      {/* Form panel */}
      <section className="relative flex flex-1 items-center justify-center px-6 py-10">
        <div className="absolute top-4 end-4">
          <LanguageSwitcher />
        </div>
        <Suspense fallback={<LoginFallback />}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}

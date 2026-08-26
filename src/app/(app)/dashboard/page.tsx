import Link from "next/link";
import {
  ArrowRightIcon,
  ArrowLeftIcon,
  CalendarDaysIcon,
  ActivityIcon,
  InfoIcon,
  PhoneCallIcon,
  UsersIcon,
} from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/guards";
import { getDirection } from "@/i18n/config";
import { getI18n } from "@/i18n/server";

const QUICK_LINKS = [
  { href: "/today", icon: ActivityIcon, titleKey: "todayTitle", descriptionKey: "todayDescription" },
  { href: "/patients", icon: UsersIcon, titleKey: "patientsTitle", descriptionKey: "patientsDescription" },
  { href: "/appointments", icon: CalendarDaysIcon, titleKey: "appointmentsTitle", descriptionKey: "appointmentsDescription" },
  { href: "/follow-up", icon: PhoneCallIcon, titleKey: "followUpTitle", descriptionKey: "followUpDescription" },
] as const;

export default async function DashboardPage() {
  const [user, { dict, locale }] = await Promise.all([requireUser("/dashboard"), getI18n()]);
  const ArrowIcon = getDirection(locale) === "rtl" ? ArrowLeftIcon : ArrowRightIcon;

  return (
    <div className="space-y-6">
      <PageHeader
        title={dict.dashboard.title}
        subtitle={dict.dashboard.welcome.replace("{name}", user.name)}
        actions={<Badge variant="secondary">{dict.roles[user.role]}</Badge>}
      />

      {/* Foundation note — honest state instead of fake metrics */}
      <Card className="border-brand-200 bg-brand-50/60">
        <CardContent className="flex items-start gap-3">
          <span className="bg-brand-100 text-brand-700 mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg">
            <InfoIcon className="size-4" aria-hidden="true" />
          </span>
          <div className="space-y-1">
            <p className="text-sm font-semibold text-brand-900">
              {dict.dashboard.foundationNoteTitle}
            </p>
            <p className="text-brand-900/80 text-sm leading-relaxed">
              {dict.dashboard.foundationNote}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Quick links */}
      <section aria-labelledby="quick-links-title" className="space-y-3">
        <h2 id="quick-links-title" className="text-lg font-semibold">
          {dict.dashboard.quickLinksTitle}
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {QUICK_LINKS.map((link) => {
            const Icon = link.icon;
            return (
              <Link
                key={link.href}
                href={link.href}
                className="group bg-card focus-visible:ring-ring/50 rounded-xl border p-5 shadow-sm transition-shadow hover:shadow-md focus-visible:ring-[3px] focus-visible:outline-none"
              >
                <span className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-lg">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <p className="mt-3 font-semibold">
                  {dict.dashboard.cards[link.titleKey]}
                </p>
                <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                  {dict.dashboard.cards[link.descriptionKey]}
                </p>
                <span className="text-primary mt-3 inline-flex items-center gap-1 text-sm font-medium">
                  {dict.dashboard.open}
                  <ArrowIcon
                    className="size-4 transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5"
                    aria-hidden="true"
                  />
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useSession } from "@/components/SessionProvider";
import { PageHeader } from "@/components/PageHeader";
import { HrTasksPanel } from "@/components/hr/TasksPanel";
import { HrStaffPanel } from "@/components/hr/StaffPanel";
import { isAdmin } from "@/lib/roles";

/**
 * «الموارد البشرية والمهام» — القسم الواحد لملفات الطاقم والمهام.
 *
 * تبويبٌ للمهام (للمدير والاستقبال والطبيب: مهامي ومهام الفريق) وتبويبٌ للطاقم
 * (المدير وحده — فيه شروط الأجر). عربيٌّ RTL ببنية البرنامج نفسها، ومتجاوب من
 * هاتف 390px إلى شاشة مكتب.
 */
export default function HrPage() {
  const session = useSession();
  const [tab, setTab] = useState<"tasks" | "staff">("tasks");
  const staff = isAdmin(session?.role);

  return (
    <div className="mx-auto w-full max-w-6xl px-3 pb-16 pt-4 sm:px-5">
      <PageHeader title="الموارد البشرية والمهام" subtitle="ملفات الطاقم، شروط الأجر، ومهام الفريق — الخاصة فيها خاصة." />

      <div role="tablist" aria-label="أقسام الموارد البشرية" className="mb-4 flex gap-2 overflow-x-auto">
        <button
          role="tab"
          aria-selected={tab === "tasks"}
          onClick={() => setTab("tasks")}
          className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition ${
            tab === "tasks" ? "bg-navy-800 text-white shadow-card" : "bg-white text-navy-700 hover:bg-navy-50"
          }`}
        >
          المهام
        </button>
        {staff && (
          <button
            role="tab"
            aria-selected={tab === "staff"}
            onClick={() => setTab("staff")}
            className={`whitespace-nowrap rounded-xl px-4 py-2 text-sm font-semibold transition ${
              tab === "staff" ? "bg-navy-800 text-white shadow-card" : "bg-white text-navy-700 hover:bg-navy-50"
            }`}
          >
            الطاقم
          </button>
        )}
      </div>

      {tab === "tasks" ? <HrTasksPanel session={session} /> : staff ? <HrStaffPanel /> : null}
    </div>
  );
}

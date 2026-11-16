"use client";

import { useSession } from "@/components/SessionProvider";
import { CanonicalAppointmentsDay } from "@/components/appointments/CanonicalAppointmentsDay";

/**
 * الهوية الموحّدة (M2 slice 15): جلسةٌ موحّدة ترى قراءة اليوم المُسقطة وحدها، ولا تُركَّب
 * صفحة المواعيد القديمة (ولا تستدعي مساراتها التي لم تُنقل بعد). الجلسة القديمة كما هي.
 */
export default function AppointmentsLayout({ children }: { children: React.ReactNode }) {
  return useSession()?.canonical === true ? <CanonicalAppointmentsDay /> : children;
}

"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/SessionProvider";
import { CanonicalTodayQueue } from "@/components/today/CanonicalTodayQueue";

/**
 * قائمة اليوم للهوية الموحّدة (M2 slice 11). الجلسة القديمة تبقى على لوحة اليوم في «/»
 * كما هي؛ هذه الصفحة لا تضيف لها شيئًا.
 */
export default function VisitsPage() {
  const session = useSession();
  const router = useRouter();
  const canonical = session?.canonical === true;
  useEffect(() => { if (session && !canonical) router.replace("/"); }, [session, canonical, router]);
  return canonical ? <CanonicalTodayQueue /> : null;
}

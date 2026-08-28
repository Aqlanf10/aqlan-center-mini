"use client";

import { createContext, useContext } from "react";
import type { Role } from "@/lib/roles";

/**
 * هوية من يستخدم البرنامج الآن.
 *
 * تُقرأ على الخادم في التخطيط الجذري وتُمرَّر هنا، فتعرف القشرة أيّ الشاشات تُظهر.
 * وإخفاء الشاشة **ليس** الحماية — الحماية في المسارات نفسها — لكنه الفرق بين قائمة
 * نصفها يعطي «ممنوع» وقائمة تعرض ما يستطيع صاحبها فعله.
 */
export interface SessionInfo {
  username: string;
  role: Role | string;
}

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({ value, children }: {
  value: SessionInfo | null;
  children: React.ReactNode;
}) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionInfo | null {
  return useContext(SessionContext);
}

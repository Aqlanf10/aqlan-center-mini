"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { Role } from "@/lib/roles";
import type { DoctorPermissions } from "@/lib/doctor-permissions";

/**
 * هوية من يستخدم البرنامج الآن.
 *
 * (P2-FIX-1) الجلسة في المتصفح كوكي HttpOnly حصراً — لا توكن في JavaScript:
 *  • الحالة تُقرأ على الخادم في التخطيط الجذري وتُمرَّر هنا (مصدر الحقيقة).
 *  • بعد التحديث (refresh) تُستعاد الحالة من الخادم عبر /api/auth/me المعتمد
 *    بالكوكي — لا يُستعاد أي شيء من localStorage، فالتخزين المحلي ليس مصدر
 *    جلسةٍ ولا دورٍ ولا صلاحيات.
 *  • لا مُمرِّر Authorization تلقائي لطلبات /api/*: طلبات المتصفح كوكيها
 *    يكفيها، وحارس الـmutations يعاملها بمسار CSRF المتصفح كاملًا.
 *  • توكن Bearer يبقى خياراً للتطبيقات الخارجية (native) عبر تدفق صريح
 *    منفصل غير المتصفح — لا يُصدر من دخول المتصفح ولا يُخزَّن في الصفحة.
 */
export interface SessionInfo {
  username: string;
  role: Role | string;
  displayName?: string;
  permissions?: DoctorPermissions | null;
}

export const PRESET_USERS: Record<string, SessionInfo> = {
  admin: {
    username: "admin",
    role: "admin",
    displayName: "المدير العام (د. عقلان)",
  },
  doctor: {
    username: "doctor",
    role: "doctor",
    displayName: "د. أروى (أخصائي التقويم)",
  },
  reception: {
    username: "reception",
    role: "reception",
    displayName: "استقبال المركز",
  },
};

interface SessionContextType {
  session: SessionInfo | null;
  setSession: (s: SessionInfo | null) => void;
  /** (P2-FIX-1) تبديل الأدوار للمعاينة/التطوير فقط — محذوف من بناء الإنتاج. */
  switchRole: ((role: "admin" | "doctor" | "reception") => void) | null;
  logout: () => Promise<void>;
  ready: boolean;
}

const SessionContext = createContext<SessionContextType>({
  session: null,
  setSession: () => {},
  switchRole: null,
  logout: async () => {},
  ready: true,
});

export function SessionProvider({ value, children }: {
  value: SessionInfo | null;
  children: React.ReactNode;
}) {
  const [session, setSessionState] = useState<SessionInfo | null>(() => value ?? null);
  const [ready, setReady] = useState(Boolean(value));

  const setSession = useCallback((newSession: SessionInfo | null) => {
    /* الحالة في الذاكرة فقط — لا كتابة توكن ولا جلسة في localStorage.
       (وفيها يُنظَّف أي أثر قديم من نسخ سابقة — انظر التطبيع في التركيب.) */
    setSessionState(newSession);
  }, []);

  /* (P2-FIX-1) تبديل الأدوار بلا جلسة خادم أصلًا — بقاؤه في الإنتاج يعني
     قشرةً تعرض شاشات دورٍ لم يوثّق الخادم جلسته. محصور بالتطوير/المعاينة.

     والنداء غير مشروط عمدًا: كان `useCallback` داخل ثلاثيّة، وهو نداء hook
     مشروط. يمرّ اليوم لأن Next يثبّت NODE_ENV في البناء فيصير الشرط ثابتًا —
     أي أن سلامته عرَضٌ لا ضمان، ويسقط لحظة يصير الشرط متغيّرًا. فالمشروط الآن
     **القيمة** لا النداء: الدالّة تُبنى دائمًا، ولا تُسلَّم في الإنتاج. */
  const switchRoleCallback = useCallback((roleKey: "admin" | "doctor" | "reception") => {
    const user = PRESET_USERS[roleKey];
    if (user) setSessionState(user);
  }, []);
  const switchRole = process.env.NODE_ENV === "production" ? null : switchRoleCallback;

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setSessionState(null);
  }, []);

  useEffect(() => {
    /* تنظيف آثار الجلسة القديمة (P2-FIX-1): أي توكن أو هوية مخزّنة من نسخ
       سابقة يُمحى فوراً — localStorage لا يحمل جلسة بعد اليوم. */
    try {
      localStorage.removeItem("aqlan_session_token");
      localStorage.removeItem("aqlan_session_user");
    } catch {
      // ignore
    }

    if (value) {
      setSessionState(value);
      setReady(true);
      return;
    }

    /* الاستعادة بعد التحديث من الخادم حصراً — /api/auth/me يعتمد كوكي
       HttpOnly ولا يُصدَّق أي شيء كتبه العميل في تخزينه المحلي. */
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/auth/me", { headers: { Accept: "application/json" } });
        if (cancelled) return;
        if (response.ok) {
          const me = (await response.json()) as {
            username?: string;
            displayName?: string;
            role?: string;
            permissions?: DoctorPermissions | null;
          };
          if (me?.username && me?.role) {
            setSessionState({
              username: me.username,
              displayName: me.displayName,
              role: me.role,
              permissions: me.permissions ?? null,
            });
          } else {
            setSessionState(null);
          }
        } else {
          setSessionState(null);
        }
      } catch {
        if (!cancelled) setSessionState(null);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [value]);

  return (
    <SessionContext.Provider value={{ session, setSession, switchRole, logout, ready }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionInfo | null {
  const context = useContext(SessionContext);
  return context.session;
}

export function useSessionActions() {
  const context = useContext(SessionContext);
  return {
    session: context.session,
    setSession: context.setSession,
    switchRole: context.switchRole,
    logout: context.logout,
    ready: context.ready,
  };
}

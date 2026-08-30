"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { Role } from "@/lib/roles";

/**
 * هوية من يستخدم البرنامج الآن.
 *
 * تُقرأ على الخادم في التخطيط الجذري وتُمرَّر هنا، فتعرف القشرة أيّ الشاشات تُظهر.
 * كما تدعم الاستعادة التلقائية والتحديث المباشر من التخزين المحلي في بيئات المعاينة والـ iFrame.
 */
export interface SessionInfo {
  username: string;
  role: Role | string;
  displayName?: string;
  token?: string;
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
    role: "receptionist",
    displayName: "استقبال المركز",
  },
};

const DEFAULT_SESSION: SessionInfo = PRESET_USERS.admin;

interface SessionContextType {
  session: SessionInfo;
  setSession: (s: SessionInfo | null) => void;
  switchRole: (role: "admin" | "doctor" | "reception") => void;
  logout: () => Promise<void>;
  ready: boolean;
}

const SessionContext = createContext<SessionContextType>({
  session: DEFAULT_SESSION,
  setSession: () => {},
  switchRole: () => {},
  logout: async () => {},
  ready: true,
});

// تفعيل ممرر التوثيق التلقائي لجميع طلبات العميل
if (typeof window !== "undefined") {
  const originalFetch = window.fetch;
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    try {
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      // إضافة ترويسة التحقق حصراً للمسارات الداخلية /api/
      if (urlStr.startsWith("/api/") || (urlStr.startsWith(window.location.origin + "/api/"))) {
        init = init || {};
        const headers = new Headers(init.headers || {});
        const token = localStorage.getItem("aqlan_session_token");
        if (token && !headers.has("Authorization")) {
          headers.set("Authorization", `Bearer ${token}`);
        }
        const storedUser = localStorage.getItem("aqlan_session_user");
        if (storedUser && !headers.has("x-session-user")) {
          headers.set("x-session-user", storedUser);
        }
        init.headers = headers;
      }
    } catch {
      // ignore
    }
    return originalFetch.call(this, input, init);
  };
}

export function SessionProvider({ value, children }: {
  value: SessionInfo | null;
  children: React.ReactNode;
}) {
  const [session, setSessionState] = useState<SessionInfo>(() => value || DEFAULT_SESSION);
  const [ready, setReady] = useState(true);

  const setSession = useCallback((newSession: SessionInfo | null) => {
    const target = newSession || DEFAULT_SESSION;
    setSessionState(target);
    try {
      localStorage.setItem("aqlan_session_user", JSON.stringify({
        username: target.username,
        role: target.role,
        displayName: target.displayName,
      }));
      if (target.token) {
        localStorage.setItem("aqlan_session_token", target.token);
      }
    } catch {
      // ignore
    }
  }, []);

  const switchRole = useCallback((roleKey: "admin" | "doctor" | "reception") => {
    const user = PRESET_USERS[roleKey] || DEFAULT_SESSION;
    setSession(user);
  }, [setSession]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {
      // ignore
    }
    setSession(DEFAULT_SESSION);
  }, [setSession]);

  useEffect(() => {
    try {
      const storedUser = localStorage.getItem("aqlan_session_user");
      if (storedUser) {
        const parsed = JSON.parse(storedUser);
        if (parsed?.username) {
          setSessionState((prev) => ({
            ...prev,
            ...parsed,
          }));
        }
      } else {
        localStorage.setItem("aqlan_session_user", JSON.stringify({
          username: DEFAULT_SESSION.username,
          role: DEFAULT_SESSION.role,
          displayName: DEFAULT_SESSION.displayName,
        }));
      }
    } catch {
      // ignore
    }
  }, []);

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



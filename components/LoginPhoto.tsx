"use client";
import { useState } from "react";
import { Logo } from "./Icon";
import { useSetting } from "./SettingsProvider";
export function LoginPhoto() {
  const visible = useSetting("clinic.login_photo_visible") === "true";
  const [failed, setFailed] = useState(false);
  return visible && !failed
    ? <div className="mb-5 h-28 w-28 overflow-hidden rounded-full border-2 border-brand-orange bg-navy-900 sm:h-32 sm:w-32">
      <img src="/api/branding/login-photo" alt="صورة شاشة الدخول" onError={() => setFailed(true)}
        draggable={false} className="h-full w-full object-cover object-top" />
    </div>
    : <div className="mb-5 hidden rounded-full border-2 border-brand-orange bg-white/5 p-6 lg:block">
      <Logo variant="white" className="h-20 w-20" />
    </div>;
}

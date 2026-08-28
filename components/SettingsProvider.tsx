"use client";

import { createContext, useContext } from "react";
import { SETTING_DEFAULTS, chairCount, type SettingsMap } from "@/lib/settings";

/**
 * الإعدادات في متناول كل صفحة بلا طلب شبكة.
 *
 * التخطيط الجذري يقرأها على الخادم مرة ويمرّرها هنا، فتصل الصفحات جاهزة مع أول
 * رسم. البديل — أن تطلبها كل صفحة بنفسها — كان يعني وميض «مركز…» ثم الاسم الحقيقي
 * على كل شاشة، وعدد كراسٍ خاطئًا في أول ثانية من عمر اللوحة.
 */
const SettingsContext = createContext<Partial<SettingsMap>>({});

export function SettingsProvider({ value, children }: {
  value: Partial<SettingsMap>;
  children: React.ReactNode;
}) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): Partial<SettingsMap> {
  return useContext(SettingsContext);
}

export function useSetting(key: keyof SettingsMap): string {
  const settings = useContext(SettingsContext);
  return settings[key] ?? SETTING_DEFAULTS[key];
}

export function useClinicName(): string {
  return useSetting("clinic.name");
}

export function useChairCount(): number {
  const settings = useContext(SettingsContext);
  return chairCount({ ...SETTING_DEFAULTS, ...settings } as SettingsMap);
}

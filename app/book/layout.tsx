import type { Metadata } from "next";
import { getSettingsSafe } from "@/lib/db";

/**
 * عنوان الصفحة من الإعدادات لا من ثابت.
 *
 * هذه أول صفحة يراها المريض، وعنوان التبويب فيها اسم المركز. `generateMetadata`
 * تُقرأ عند الطلب لا عند البناء، فتغيير الاسم من شاشة الإعدادات يظهر فورًا.
 */
export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSettingsSafe();
  return {
    title: `طلب موعد — ${settings["clinic.name"]}`,
    description: "اطلب موعدًا في المركز، وسنتصل بك لتأكيد الوقت.",
  };
}

export default function BookLayout({ children }: { children: React.ReactNode }) {
  return children;
}

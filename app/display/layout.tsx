import type { Metadata } from "next";

/**
 * شاشة الصالة تُستثنى من الفهرسة.
 *
 * الصفحة مفتوحة بلا جلسة لأن التلفاز لا يسجّل الدخول كل صباح، ولا سبب يجعل محرك بحث
 * يحفظ نسخة من أسماء من كان في العيادة صباح الثلاثاء. `noindex` لا تحمي الصفحة —
 * الحماية أنها لا تحمل إلا الاسم الأول ورقم الكرسي — لكنها تمنع بقاء أثرها بعد اليوم.
 */
export const metadata: Metadata = {
  title: "شاشة النداء — مركز الدكتور عقلان الكامل",
  robots: { index: false, follow: false },
};

export default function DisplayLayout({ children }: { children: React.ReactNode }) {
  return children;
}

import Link from "next/link";

export default function PatientNumberingPage() {
  return <main className="mx-auto max-w-3xl space-y-4 p-4" dir="rtl">
    <Link href="/settings" className="underline">العودة إلى الإعدادات</Link>
    <h1 className="text-2xl font-bold">ترقيم ملفات المرضى الجدد</h1>
    <p role="status">تعديل الترقيم غير مفعّل في هذه النسخة. أرقام الملفات السابقة لا تتغيّر.</p>
  </main>;
}

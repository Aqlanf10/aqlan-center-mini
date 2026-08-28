import "./print.css";

/**
 * صفحات الطباعة.
 *
 * خارج قشرة البرنامج عمدًا: القائمة الجانبية والشريط السفلي لا مكان لهما على ورقة.
 * والصفحة تُفتح في تبويب جديد ثم تُطبع بـCtrl+P — بلا مكتبة PDF ولا خادم توليد،
 * لأن كليهما خطوة إضافية تتعطّل يوم تحتاجها الاستقبال.
 */
export default function PrintLayout({ children }: { children: React.ReactNode }) {
  return <div className="print-root">{children}</div>;
}

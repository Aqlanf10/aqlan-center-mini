import { Icon, type IconName } from "./Icon";

/**
 * ترويسة الشاشة — واحدة لكل الشاشات.
 *
 * كانت كل صفحة تكتب ترويستها: عنوانٌ بحجم هنا وآخر هناك، وصفّ روابط بشكل في المالية
 * وبشكل في الإعدادات، وزرُّ الفعل الرئيسي مرة يمينًا ومرة تحت العنوان. ونتيجة ذلك
 * ليست قبحًا فقط — هي أن المستخدم يعيد تعلّم مكان الأشياء في كل شاشة يفتحها.
 *
 * والروابط هنا **روابط بين شاشات شقيقة** لا تنقّل رئيسي: التنقّل الرئيسي في القشرة،
 * وهذه تقول «أين أنا داخل هذا القسم».
 */

export interface HeaderLink {
  href: string;
  label: string;
  /** الشاشة الحالية: تُعرض مضاءة ولا تُجعل رابطًا إلى نفسها. */
  current?: boolean;
}

export function PageHeader({ title, subtitle, links, children, back }: {
  title: string;
  subtitle?: string;
  links?: HeaderLink[];
  /** الفعل الرئيسي للشاشة — واحد لا أربعة. */
  children?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header className="mb-5">
      {back ? (
        <a href={back.href}
          className="mb-2 inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-navy-800">
          <Icon name="back" className="h-3.5 w-3.5" />
          {back.label}
        </a>
      ) : null}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-bold leading-tight text-navy-900">{title}</h1>
          {subtitle ? (
            <p className="mt-1 text-xs font-medium text-slate-500">{subtitle}</p>
          ) : null}
        </div>
        {children ? <div className="flex shrink-0 flex-wrap gap-2">{children}</div> : null}
      </div>

      {links && links.length > 0 ? (
        <nav className="mt-3 flex flex-wrap gap-1.5">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              aria-current={link.current ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                link.current
                  ? "bg-navy-900 text-white"
                  : "border border-slate-200 bg-white text-navy-800 hover:border-navy-200 hover:bg-navy-50"
              }`}
            >
              {link.label}
            </a>
          ))}
        </nav>
      ) : null}
    </header>
  );
}

/**
 * الفعل الرئيسي للشاشة.
 *
 * `tone` يقول **معنى** الزر لا لونه: `primary` للفعل المتوقَّع، و`danger` لما يتلف
 * ولا رجعة فيه. والفرق ليس تجميليًا — زرٌّ يومي بلون الخطر يعلّم المستخدم أن يتجاهل
 * الأحمر، فحين يظهر أحمرٌ حقيقي لا يراه.
 */
export function ActionButton({ tone = "primary", children, ...rest }: {
  tone?: "primary" | "accent" | "quiet" | "danger";
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const styles = {
    primary: "bg-navy-900 text-white hover:bg-navy-800",
    accent: "bg-accent-500 text-white hover:bg-accent-600",
    quiet: "border border-slate-200 bg-white text-navy-800 hover:bg-slate-50",
    danger: "bg-danger-500 text-white hover:bg-danger-700",
  }[tone];
  return (
    <button
      {...rest}
      className={`rounded-xl px-4 py-2 text-sm font-bold transition-colors disabled:opacity-40 ${styles} ${rest.className ?? ""}`}
    >
      {children}
    </button>
  );
}

/**
 * بطاقة رقم.
 *
 * كانت مكرّرة حرفيًا في ثلاث شاشات — اللوحة والتقرير والمختبر — بنفس الشيفرة تمامًا.
 * وتكرارٌ متطابق ليس خطأ تجميليًا: تغييرُ لون التنبيه غدًا يُنفَّذ في موضعين ويُنسى
 * الثالث، فتصير شاشةٌ تقول «متأخر» بلونٍ وأخرى بلون آخر لنفس المعنى.
 */
export function StatCard({ label, value, hint, tone = "calm", icon }: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: "calm" | "good" | "warn" | "bad";
  icon?: IconName;
}) {
  const styles = {
    calm: "border-slate-200 bg-white text-navy-900",
    good: "border-success-300 bg-success-50 text-success-900",
    warn: "border-warning-300 bg-warning-50 text-warning-900",
    bad: "border-danger-300 bg-danger-50 text-danger-900",
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 text-center shadow-card ${styles}`}>
      {icon ? <Icon name={icon} className="mx-auto mb-1 h-4 w-4 opacity-50" /> : null}
      <p className="text-2xl font-bold leading-none">{value}</p>
      <p className="mt-1.5 text-[11px] font-semibold opacity-70">{label}</p>
      {hint ? <p className="mt-0.5 text-[10px] font-medium opacity-50">{hint}</p> : null}
    </div>
  );
}

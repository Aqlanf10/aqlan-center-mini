/**
 * (P1-C) قرار فوترة شدّة التقويم خارج العقد — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة `migrations/0039_ortho_adjustment_billing_decision.sql`
 * حرفيًّا. إضافيٌّ خالص: أعمدةٌ قابلة للفراغ على `ortho_adjustments`، لا حذف ولا إعادة تسمية ولا تعبئة
 * لصفٍّ قائم — الشدّات القديمة تبقى بلا قرار (فارغ) كما كانت.
 *
 * - `billing_class`: تصنيف الشدّة كما قرره التوقيع (لقطة) — لتقرأه التقارير دون إعادة حساب.
 * - `billing_decision`: قرار الشدّة خارج العقد: `billed` (فوتِرت بفاتورة) أو `no_charge` (بلا رسوم بسبب).
 *   الفارغ مع `OUTSIDE_CONTRACT` = قرارٌ معلّق.
 * - `billing_decision_reason`، `billing_decided_by`، `billing_decided_at`: من قرّر ولماذا ومتى.
 * - `billing_invoice_id`: الفاتورة التي فوترت الشدّة حين يكون القرار `billed`.
 */
export const ORTHO_BILLING_DECISION_SQL = `ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_class TEXT;
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_decision TEXT CHECK (billing_decision IN ('billed', 'no_charge'));
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_decision_reason TEXT;
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_decided_by TEXT;
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_decided_at TIMESTAMPTZ;
ALTER TABLE ortho_adjustments ADD COLUMN IF NOT EXISTS billing_invoice_id INTEGER REFERENCES invoices(id);
`;

/**
 * (P3-5) مصدر فعل التدقيق — مصدرٌ واحد لمسارَي المخطط.
 *
 * النص نفسه يُنفَّذ في `ensureSchema()` وهو جسد الهجرة
 * `migrations/0019_audit_source.sql` حرفيًّا — واختبار الوحدة يُسقط البناء إن افترقا.
 *
 * عنوان الجهاز (خلف وسيطٍ موثوق وحده) والمتصفح: حين يُسأل «من ألغى هذه الفاتورة؟»
 * لا يكفي اسم المستخدم إن كانت كلمة مروره عند غيره — الجهاز يجيب. أعمدة قابلة للفراغ:
 * الصفوف القديمة تبقى كما هي.
 */
export const AUDIT_SOURCE_SQL = `ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS source_ip TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS user_agent TEXT;`;

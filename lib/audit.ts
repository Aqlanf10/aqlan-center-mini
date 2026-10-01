/**
 * سجل التدقيق — المنطق الخالص.
 *
 * المبدأ الخامس في الدستور: **تاريخٌ واحد قابل للتدقيق**. وهو المبدأ الوحيد الذي لا
 * يُطلب منه أن «يعمل» بل أن **يشهد**.
 *
 * والسؤال الذي يُبنى له سؤالٌ يُطرح مرة واحدة في السنة ولا جواب له بلا سجل: «من ألغى
 * فاتورة المريض الفلاني؟» و«من غيّر سعر الدولار قبل الجرد؟» و«من فتح صلاحية
 * الصندوق لهذا الموظف؟». وفي عيادة يعمل فيها أكثر من شخص، غياب الجواب ليس نقص
 * ميزة — هو أن **الثقة تُبنى على الظنّ**، وأن الخطأ الصادق لا يُفرَّق عن غيره.
 *
 * والقاعدة الحاكمة: **يُكتب ولا يُقرأ منه إلا للمراجعة، ولا يُحذف ولا يُعدَّل أبدًا** —
 * لا من الواجهة ولا من مسار برمجي. سجلٌّ يمكن محوه يشهد لمن يملك محوه وحده.
 */

/** الأفعال المسجَّلة. قائمة مغلقة عمدًا: نصٌّ حرّ يجعل السجل غير قابل للتصفية. */
export type AuditAction =
  | "invoice.create" | "invoice.cancel" | "invoice.correct" | "invoice.status"
  | "payment.create" | "payment.refund" | "payment.idempotent_replay"
  /* (RC-1) تصحيح سند قبض خطأ: عكسٌ + سندٌ بديل (أو إبطالٌ وحده) — بسببٍ مكتوب. */
  | "payment.correct"
  | "expense.create"
  | "shift.open" | "shift.close"
  | "patient.create" | "patient.update"
  /* (P2-7) دمج ملفٍّ مكرَّر في الملف الأصلي. */
  | "patient.merge"
  /* (P1-5) استيراد دفعة مرضى من ملف المركز القديم — ببصمة الملف. */
  | "patient.import"
  /* (P2-12) جولة التذكير الآلي بواتساب للأعمال — أرقامٌ فقط. */
  | "reminder.auto"
  /* (MSG-1) قنوات المراسلة: تغيير إعداد قناة (بلا قيمة السرّ)، وإرسال رسالة عبر قناة خارجية. */
  | "messaging.channel.update" | "messaging.send"
  | "patient.medical_history" | "patient.vitals"
  /* (PAT-3) صورة المريض، وقيد موافقة التواصل (منح/سحب). */
  | "patient.photo" | "patient.contact_consent"
  /* (P1-5ج) استيراد معالجات النظام القديم ودفعاته — ببصمة الملفين. */
  | "legacy.import"
  /* (P1-6) سعر إجراءٍ خالف الدليل (خصم/رفع/خدمة غير مسعّرة) — بسببه وقراره. */
  | "visit.price_override"
  /* (P1-4) الجهات والخدمات وأسعارها — كانت تتغيّر بلا أثر. */
  | "party.create" | "party.update"
  | "service.create" | "service.update" | "service.prices.batch" | "service.prices.provisional"
  | "plan.create" | "plan.create_v2" | "plan.installment" | "plan.status" | "plan.consent"
  /* (FIA-1) الأرصدة الافتتاحية للمعامل والموردين: دَينٌ سابق وتصحيحه، ورصيدٌ مقدَّم وإلغاؤه. */
  | "party_opening.create" | "party_opening.adjust" | "party_advance.create" | "party_advance.void"
  /* (FIN-5) سعر بند خطةٍ خالف الدليل عند إضافته لخطة قائمة — بسببه وقراره. */
  | "plan.price_override"
  | "opening_balance.set" | "opening_balance.clear"
  | "legacy_balance_arrangement.create" | "legacy_balance_arrangement.cancel"
  | "fx.revalue"
  | "journal.manual"
  | "settings.update"
  /* إعدادات المركز المركزية — فعلٌ مستقلّ عن "settings.update" المُثقَل بمسارات
     المختبرات ومحاسبتها، ومعه entity="clinic_setting" فيصير التمييز مزدوجًا. */
  | "clinic_settings.update" | "clinic_settings.reset"
  | "clinic_settings.secret.replace" | "clinic_settings.secret.remove"
  | "user.create" | "user.update" | "user.disable"
  | "doctor.permissions.update" | "user.finance-permissions.update" | "doctor.commission.update"
  /* (COMM-DETAIL-1) نسبة خاصة بحالة/خطة لطبيب — تعيين أو إلغاء بصفٍّ جديد مسبَّب. */
  | "commission.case_override.set" | "commission.case_override.void"
  | "backup.download" | "export.download"
  | "document.reprint"
  | "chart.record" | "visit.sign" | "visit.addendum"
  /* (LIVE-3) حركات الطابور: من نادى، أعاد النداء، أجلس، أعاد للانتظار، أنهى التشغيل. */
  | "visit.call" | "visit.call_again" | "visit.seat" | "visit.return_to_waiting" | "visit.finish"
  /* (CHAIR-1) إقرار الجاهزية للكرسي، وتجاوز الطوارئ بسببٍ مكتوب، وتأجيل الدفع عند الشبّاك. */
  | "visit.clear" | "visit.clearance_bypass" | "visit.payment_deferred"
  | "document.upload" | "document.remove"
  /* (P3-6) مرفق سند صرف — صورة إيصال أو فاتورة مورّد. */
  | "expense.attachment"
  | "document.upload.rejected_signature"
  | "ceph.create" | "ceph.update" | "ceph.complete" | "ceph.discard"
  | "inventory.item" | "inventory.move"
  | "lab.create" | "lab.update" | "lab.delete"
  | "lab_order.cancel" | "lab_order.delete"
  | "lab_service.create" | "lab_service.update" | "lab_service.delete" | "lab_service.deactivate" | "lab_services.seed"
  | "lab_pricing.create" | "lab_pricing.update" | "lab_pricing.delete"
  | "lab.accounting.update"
  | "portal.login" | "portal.confirm" | "portal.intake" | "portal.message"
  | "display.delay_notice"
  | "display.announcement.create" | "display.announcement.update" | "display.announcement.delete"
  | "display.announcement.reorder" | "display.announcement.migrate"
  | "ai.settings.update" | "ai.test" | "ai.suggest" | "ai.chat"
  | "ai.provider.save" | "ai.provider.delete" | "ai.providers.reorder" | "ai.provider.test"
  | "ai.confirmation.execute"
  | "diagnosis.create" | "ortho.book_next"
  /* (CASE-1) حالة تقويمٍ سابقة (قبل النظام)، وشدّةٌ سُجّلت (من التبويب أو داخل توقيع الزيارة). */
  | "ortho.baseline" | "ortho.adjustment"
  | "appointment.create" | "appointment.update" | "lab_order.create"
  /* تجاوز منع السعة — فعلٌ مستقلّ يُستخرج وحده: «كم مرّة تجاوزنا الشهر الماضي
     ومن فعل ولماذا» سؤالُ إدارةٍ لا يُجاب عليه إن اختلط التجاوز بالحجز العادي. */
  | "appointment.capacity_override" | "appointment.reschedule"
  /* (المرحلة ٤ب) إدارة كتالوج خدمات المواعيد وحجب الأطباء — أفعالٌ مستقلّة،
     فتُستخرج وحدها ولا تختلط بتغييرات الإعدادات ولا بحجز المواعيد. */
  | "appointment_service.create" | "appointment_service.update"
  | "appointment_service.activate" | "appointment_service.deactivate"
  | "provider_block.create" | "provider_block.cancel"
  | "waiting_list.add" | "waiting_list.offer" | "waiting_list.resolve"
  | "waiting_list.contact" | "waiting_list.update_preferences"
  | "waiting_list.priority_change" | "waiting_list.book"
  | "patient.delete" | "appointment.delete" | "visit.delete" | "expense.delete"
  | "expense.void"
  /* (P0-2) سداد الموردين: سعر صرف يخالف الإعدادات، ودفعة مقدمة فوق الرصيد، وتسجيل التزام. */
  | "expense.rate_override" | "expense.prepayment" | "payable.create"
  // ── من مستودع الوكيل الآخر: بوابة التسعير، نسب الإهلاك، الوصفات، النسخة الكاملة ──
  | "services.price_batch" | "services.provisional"
  | "material_rate.set" | "material_rate.clear"
  | "prescription.create" | "prescription.void"
  | "referral.create" | "referral.complete" | "referral.cancel"
  /* (REF-1) خطوات الإحالة الداخلية. */
  | "referral.accept" | "referral.decline" | "referral.schedule" | "referral.return"
  /* (REF-2) خطوات النظام: الوصول، والتقدّم بالتوقيع، وعودة الإحالة لانتظار الحجز. */
  | "referral.arrive" | "referral.progress" | "referral.unschedule"
  /* (CASE-MODEL-1) الحالات التخصصية وقائمة المشاكل وترتيب بنود الخطة واعتمادياتها. */
  | "case.create" | "case.status" | "problem.create" | "problem.status"
  | "plan.item_case" | "plan.dependency_add" | "plan.dependency_remove" | "plan.dependency_override"
  /* (PAT-4) العائلات والضامن — معلومةٌ لا مال. */
  | "family.create" | "family.link" | "family.unlink" | "family.guarantor" | "family.rename"
  | "backup.full_download" | "backup.complete"
  /* إعادة الضبط: مسح البيانات التجريبية كلها — فعلٌ لا يتكرر إلا بقرار المالك. */
  | "system.reset";

export const AUDIT_LABEL: Record<AuditAction, string> = {
  "invoice.create": "إنشاء فاتورة",
  "invoice.cancel": "إلغاء فاتورة",
  "invoice.correct": "تصحيح فاتورة",
  "invoice.status": "تغيير حالة فاتورة يدويًّا",
  "payment.create": "سند قبض",
  "payment.refund": "استرداد",
  "payment.correct": "تصحيح سند قبض",
  "payment.idempotent_replay": "إعادة طلب مالي بمفتاح الإعادة",
  "expense.create": "سند صرف",
  "shift.open": "فتح وردية",
  "shift.close": "إغلاق وردية وجرد",
  "patient.create": "إضافة مريض",
  "patient.update": "تعديل بيانات مريض",
  "patient.merge": "دمج ملف مريض مكرر",
  "system.reset": "إعادة ضبط — مسح البيانات التجريبية",
  "patient.import": "استيراد مرضى من ملف",
  "reminder.auto": "جولة التذكير الآلي بواتساب",
  "messaging.channel.update": "تعديل إعدادات قناة مراسلة",
  "messaging.send": "إرسال رسالة عبر قناة خارجية",
  "patient.medical_history": "تحديث التاريخ الطبي للمريض",
  "patient.vitals": "تسجيل علامات حيوية",
  "patient.photo": "تغيير صورة المريض",
  "patient.contact_consent": "تسجيل موافقة تواصل للمريض",
  "legacy.import": "استيراد معالجات ودفعات النظام القديم",
  "visit.price_override": "سعر إجراء يخالف الدليل",
  "party.create": "إضافة جهة (طبيب/مورد/مختبر)",
  "party.update": "تعديل بيانات جهة",
  "service.create": "إضافة خدمة إلى الدليل",
  "service.update": "تعديل خدمة أو سعرها",
  "service.prices.batch": "تسعير الدليل دفعةً واحدة",
  "service.prices.provisional": "إكمال أسعار تقديرية للدليل",
  "plan.create": "إنشاء خطة علاج",
  "plan.create_v2": "إنشاء خطة علاج (رحلة موحَّدة)",
  "party_opening.create": "إدخال دَين سابق لمختبر/مورد (رصيد افتتاحي)",
  "party_opening.adjust": "تصحيح دَين سابق لمختبر/مورد",
  "party_advance.create": "إدخال رصيد مقدَّم سابق لدى مختبر/مورد",
  "party_advance.void": "إلغاء رصيد مقدَّم سابق لدى مختبر/مورد",
  "plan.price_override": "سعر بند خطة يخالف الدليل",
  "plan.installment": "تحصيل قسط",
  "plan.status": "تغيير حالة خطة",
  "plan.consent": "موافقة على خطة علاج",
  "opening_balance.set": "إثبات رصيد افتتاحي",
  "opening_balance.clear": "حذف رصيد افتتاحي",
  "legacy_balance_arrangement.create": "ترتيب تحصيل رصيد سابق",
  "legacy_balance_arrangement.cancel": "إلغاء ترتيب تحصيل رصيد سابق",
  "fx.revalue": "إعادة تقييم عملة",
  "journal.manual": "قيد يدوي",
  "settings.update": "تغيير إعداد",
  "clinic_settings.update": "تغيير إعداد مركزي",
  "clinic_settings.reset": "إعادة إعداد إلى الافتراضي",
  "clinic_settings.secret.replace": "استبدال سرّ إعداد",
  "clinic_settings.secret.remove": "إزالة سرّ إعداد",
  "user.create": "إنشاء مستخدم",
  "user.update": "تعديل مستخدم",
  "user.disable": "تعطيل مستخدم",
  "doctor.permissions.update": "تعديل صلاحيات الطبيب",
  "user.finance-permissions.update": "تعديل صلاحيات مالية لمستخدم",
  "doctor.commission.update": "تعديل نسبة/طريقة احتساب الطبيب",
  "commission.case_override.set": "تعيين نسبة عمولة خاصة بحالة",
  "commission.case_override.void": "إلغاء نسبة عمولة خاصة بحالة",
  "backup.download": "تنزيل نسخة احتياطية",
  "export.download": "تصدير بيانات",
  "document.reprint": "إعادة طباعة مستند",
  "chart.record": "تثبيت حالة سن",
  "visit.sign": "توقيع زيارة",
  "visit.addendum": "ملحق على زيارة",
  "visit.call": "نداء مريض إلى كرسي",
  "visit.call_again": "إعادة النداء",
  "visit.seat": "إجلاس مريض على الكرسي",
  "visit.return_to_waiting": "إعادة مريض إلى الانتظار",
  "visit.finish": "إنهاء تشغيل الزيارة",
  "visit.clear": "إقرار جاهزية المريض للكرسي",
  "visit.clearance_bypass": "إدخال طوارئ قبل إقرار الجاهزية",
  "visit.payment_deferred": "تأجيل الدفع عند الشبّاك",
  "document.upload": "رفع مستند",
  "expense.attachment": "إرفاق إيصال بسند صرف",
  "document.upload.rejected_signature": "رفع مرفوض — بصمة المحتوى لا تطابق النوع",
  "document.remove": "إخفاء مستند",
  "ceph.create": "فتح تحليل سيفالومتري",
  "ceph.update": "تحديث تحليل سيفالومتري",
  "ceph.complete": "اعتماد تحليل سيفالومتري",
  "ceph.discard": "رفض مسودة سيفالومتري",
  "inventory.item": "إدارة بند مخزون",
  "inventory.move": "حركة مخزون",
  "lab.create": "إضافة مختبر جديد",
  "lab.update": "تعديل بيانات مختبر",
  "lab.delete": "حذف/تعطيل مختبر",
  "lab_order.cancel": "إلغاء إرسالية مختبر",
  "lab_order.delete": "حذف أمر مختبر نهائيًا",
  "lab_service.create": "إضافة خدمة مختبر",
  "lab_service.update": "تعديل خدمة مختبر",
  "lab_service.delete": "حذف خدمة مختبر",
  "lab_service.deactivate": "تعطيل خدمة مختبر",
  "lab_services.seed": "بذر دليل خدمات المختبر",
  "lab_pricing.create": "إضافة قاعدة تسعير مختبر",
  "lab_pricing.update": "تعديل قاعدة تسعير مختبر",
  "lab_pricing.delete": "حذف قاعدة تسعير مختبر",
  "lab.accounting.update": "تعديل الربط المحاسبي لمختبر",
  "portal.login": "دخول مريض إلى البوابة",
  "portal.confirm": "تأكيد حضور موعد (بوابة)",
  "portal.intake": "استمارة صحية من البوابة",
  "portal.message": "رسالة من بوابة المريض",
  "display.delay_notice": "تشغيل/إيقاف رسالة الاعتذار على شاشة الصالة",
  "display.announcement.create": "إضافة إعلان لشاشة الصالة",
  "display.announcement.update": "تعديل إعلان شاشة الصالة",
  "display.announcement.delete": "حذف إعلان شاشة الصالة",
  "display.announcement.reorder": "ترتيب إعلانات شاشة الصالة",
  "display.announcement.migrate": "ترحيل إعلانات الصالة القديمة إلى السجلات",
  "ai.settings.update": "تغيير إعدادات الذكاء الاصطناعي",
  "ai.test": "اختبار اتصال الذكاء الاصطناعي",
  "ai.suggest": "اقتراح من الذكاء الاصطناعي (غير معتمد)",
  "ai.chat": "محادثة مع المساعد الذكي",
  "ai.provider.save": "حفظ مزود ذكاء اصطناعي",
  "ai.provider.delete": "حذف مزود ذكاء اصطناعي",
  "ai.providers.reorder": "إعادة ترتيب أولويات مزودي الذكاء الاصطناعي",
  "ai.provider.test": "اختبار مزود ذكاء اصطناعي",
  "ai.confirmation.execute": "تنفيذ إجراء مؤكد عبر المساعد الذكي",
  "patient.delete": "حذف ملف مريض نهائيًا بكل سجلاته",
  "appointment.delete": "حذف موعد",
  "visit.delete": "حذف زيارة",
  "expense.delete": "حذف سند صرف",
  "expense.void": "إبطال سند صرف بقيد معاكس",
  "expense.rate_override": "سند صرف بسعر صرف يخالف الإعدادات",
  "expense.prepayment": "دفعة مقدمة فوق رصيد مورد/مختبر",
  "payable.create": "تسجيل التزام لجهة (فاتورة مورد/مختبر)",
  "services.price_batch": "تسعير دفعة واحدة",
  "services.provisional": "ملء أسعار تخمينية موسومة",
  "material_rate.set": "تحديد نسبة إهلاك مواد",
  "material_rate.clear": "محو نسبة إهلاك مواد",
  "prescription.create": "إصدار وصفة موثّقة",
  "prescription.void": "إبطال وصفة بسببها",
  "referral.create": "إحالة مريض إلى أخصائي",
  "referral.complete": "إغلاق إحالة بنتيجتها",
  "referral.cancel": "إلغاء إحالة بسببها",
  "referral.accept": "قبول إحالة داخلية",
  "referral.decline": "الاعتذار عن إحالة داخلية بسببه",
  "referral.schedule": "حجز موعد إحالة داخلية",
  "referral.return": "اطّلاع المحيل على نتيجة الإحالة",
  "referral.arrive": "وصول مريض الإحالة الداخلية",
  "referral.progress": "بدء علاج الإحالة الداخلية بتوقيع زيارتها",
  "referral.unschedule": "عودة الإحالة لانتظار الحجز (أُلغي موعدها أو لم يحضر)",
  "case.create": "فتح حالة تخصصية",
  "case.status": "تغيير حالة تخصصية",
  "problem.create": "تسجيل مشكلة في قائمة المشاكل",
  "problem.status": "تغيير حالة مشكلة",
  "plan.item_case": "ربط بند خطة بحالة أو تغيير أولويته",
  "plan.dependency_add": "إضافة اعتماد بين بندين",
  "plan.dependency_remove": "إزالة اعتماد بين بندين",
  "plan.dependency_override": "متابعة بندٍ قبل اكتمال ما يتطلبه (بسبب)",
  "family.create": "إنشاء عائلة",
  "family.link": "ربط مريض بعائلة أو تغيير صلته",
  "family.unlink": "فكّ مريض من عائلته",
  "family.guarantor": "تعيين ضامن العائلة أو تغييره",
  "family.rename": "تعديل اسم العائلة أو ملاحظتها",
  "backup.full_download": "تنزيل نسخة كاملة (بيانات وأشعّة)",
  "backup.complete": "اكتمال بثّ نسخة كاملة",
  "diagnosis.create": "فتح نسخة تشخيص",
  "ortho.book_next": "حجز جلسة التقويم القادمة",
  "ortho.baseline": "تسجيل حالة تقويم سابقة (قبل النظام)",
  "ortho.adjustment": "تسجيل شدّة تقويم",
  "appointment.create": "حجز موعد",
  "appointment.capacity_override": "تجاوز منع السعة",
  "appointment.reschedule": "نقل موعد",
  "appointment_service.create": "إنشاء خدمة موعد",
  "appointment_service.update": "تعديل خدمة موعد",
  "appointment_service.activate": "تفعيل خدمة موعد",
  "appointment_service.deactivate": "تعطيل خدمة موعد",
  "waiting_list.add": "إضافة إلى قائمة الانتظار",
  "waiting_list.contact": "تسجيل محاولة اتصال بمنتظِر",
  "waiting_list.update_preferences": "تعديل تفضيلات انتظار",
  "waiting_list.priority_change": "تغيير أولوية منتظِر",
  "waiting_list.book": "تحويل انتظار إلى موعد",
  "waiting_list.offer": "نداء منتظِر على مكانٍ شاغر",
  "waiting_list.resolve": "إغلاق انتظار",
  "provider_block.create": "حجب وقت طبيب",
  "provider_block.cancel": "إلغاء حجب طبيب",
  "appointment.update": "تعديل حالة موعد",
  "lab_order.create": "إنشاء أمر معمل",
};

/**
 * الأفعال التي تستحق **انتباهًا** عند المراجعة.
 *
 * ليست «مشبوهة» — هي التي يُسأل عنها أولًا حين يُراجَع شهر. وتمييزها في الشاشة يوفّر
 * على المالك قراءة ألف سطر ليصل إلى العشرة التي تهمّه.
 */
export const SENSITIVE_ACTIONS: AuditAction[] = [
  "appointment.capacity_override",
  "appointment_service.create", "appointment_service.update",
  "appointment_service.activate", "appointment_service.deactivate",
  "system.reset",
  "patient.import", "legacy.import",
  "invoice.cancel", "invoice.correct", "invoice.status", "plan.status",
  "party_opening.create", "party_opening.adjust", "party_advance.create", "party_advance.void", "payment.refund", "payment.correct", "expense.void", "expense.rate_override", "expense.prepayment", "opening_balance.set", "opening_balance.clear",
  "journal.manual", "fx.revalue", "settings.update", "user.create", "user.update",
  "clinic_settings.update", "clinic_settings.reset",
  "clinic_settings.secret.replace", "clinic_settings.secret.remove",
  "user.disable", "doctor.permissions.update", "user.finance-permissions.update", "doctor.commission.update",
  "commission.case_override.set", "commission.case_override.void",
  "backup.download", "export.download", "document.reprint",
  "visit.addendum", "visit.clearance_bypass", "ai.settings.update", "ai.provider.save", "ai.provider.delete",
];

export function isSensitive(action: AuditAction): boolean {
  return SENSITIVE_ACTIONS.includes(action);
}

export interface AuditEntry {
  id: number;
  action: AuditAction;
  /** نوع الكيان ورقمه: `invoice/42` — فيُعرف على ماذا وقع الفعل. */
  entity: string | null;
  entityId: string | null;
  /** وصفٌ عربي جاهز للقراءة: السجل يُقرأ في لحظة توتّر لا في وقت فراغ. */
  summary: string;
  /** ما تغيّر — بلا أسرار ولا بيانات حسّاسة. */
  details: Record<string, unknown> | null;
  actor: string;
  actorRole: string | null;
  createdAt: string;
  /** (P3-5) عنوان الجهاز — خلف وسيطٍ موثوق وحده؛ null لما قبله أو بلا وسيط. */
  sourceIp?: string | null;
  /** (P3-5) المتصفح/الجهاز كما أعلن نفسه. */
  userAgent?: string | null;
}

/**
 * ينظّف التفاصيل قبل الحفظ.
 *
 * السجل يُقرأ ويُصدَّر ويُطبع، فما يدخله يخرج منه. وكلمة سرّ أو رمز جلسة يتسرّب إلى
 * سطر تدقيق يبقى فيه إلى الأبد — والسجل نفسه لا يُحذف منه شيء، فلا سبيل لسحبه.
 */
const SECRET_KEYS = /pass|secret|token|hash|كلمة|سر|رمز/i;

export function sanitizeDetails(
  input: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!input) return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRET_KEYS.test(key)) continue;
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 300) {
      clean[key] = `${value.slice(0, 300)}…`;
      continue;
    }
    clean[key] = value;
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/** وصفٌ مختصر لسطر التدقيق — يُبنى مرة ويُخزَّن، فلا يتغيّر معناه بتغيّر الكود. */
export function describeAudit(
  action: AuditAction,
  entityLabel?: string | null,
): string {
  const base = AUDIT_LABEL[action];
  return entityLabel ? `${base} — ${entityLabel}` : base;
}

/**
 * Arabic dictionary — source of truth for the Dictionary type.
 * Keep keys in sync with `en.ts` (en is typed as Dictionary, so a missing
 * key fails `npm run typecheck`).
 */
export const ar = {
  app: {
    name: "Aqlan Center Mini",
    centerName: "مركز الدكتور عقلان الكامل لتقويم وزراعة وتجميل الأسنان",
    tagline: "نظام إدارة العمليات اليومية",
  },
  common: {
    loading: "جارٍ التحميل…",
    retry: "إعادة المحاولة",
    cancel: "إلغاء",
    save: "حفظ",
    search: "بحث",
    searchPlaceholder: "ابحث…",
    actions: "إجراءات",
    back: "رجوع",
    home: "الرئيسية",
    menu: "القائمة",
    close: "إغلاق",
    openMenu: "فتح القائمة",
    closeMenu: "إغلاق القائمة",
    error: "حدث خطأ",
    errorHint: "حاول مرة أخرى، وإذا استمرت المشكلة تواصل مع المسؤول.",
    language: "اللغة",
    switchLanguage: "تغيير اللغة",
    notFoundTitle: "الصفحة غير موجودة",
    notFoundHint: "الرابط الذي طلبته غير متاح.",
  },
  nav: {
    dashboard: "لوحة التحكم",
    today: "اليوم",
    patients: "المرضى",
    appointments: "المواعيد",
    followUp: "المتابعة",
    mainNavigation: "التنقل الرئيسي",
  },
  auth: {
    loginTitle: "تسجيل الدخول",
    loginSubtitle: "ادخل بيانات حسابك للوصول إلى نظام المركز",
    username: "اسم المستخدم",
    usernamePlaceholder: "مثال: admin",
    password: "كلمة المرور",
    passwordPlaceholder: "••••••••",
    showPassword: "إظهار كلمة المرور",
    hidePassword: "إخفاء كلمة المرور",
    submit: "دخول",
    submitting: "جارٍ تسجيل الدخول…",
    usernameRequired: "اسم المستخدم مطلوب",
    passwordRequired: "كلمة المرور مطلوبة",
    passwordTooShort: "كلمة المرور يجب أن تكون 8 أحرف على الأقل",
    invalidCredentials: "اسم المستخدم أو كلمة المرور غير صحيحة",
    loginFailed: "تعذر تسجيل الدخول، حاول مرة أخرى",
    signedInAs: "مسجّل الدخول بواسطة",
    signOut: "تسجيل الخروج",
    signingOut: "جارٍ تسجيل الخروج…",
    role: "الدور",
  },
  roles: {
    ADMIN: "مدير النظام",
    DOCTOR: "طبيب",
    RECEPTION: "استقبال",
  },
  dashboard: {
    title: "لوحة التحكم",
    welcome: "أهلًا، {name}",
    welcomeSubtitle: "هذه لوحة التحكم الخاصة بعمليات المركز اليومية.",
    quickLinksTitle: "الوصول السريع",
    foundationNoteTitle: "مرحلة التأسيس",
    foundationNote:
      "هذه النسخة الأساسية للنظام. إدارة المرضى والمواعيد والزيارات ستُضاف في المرحلة التالية بعد مراجعة هذا الأساس. لن تظهر أي أرقام أو إحصاءات هنا حتى يتم حسابها من قاعدة البيانات الفعلية.",
    cards: {
      todayTitle: "اليوم",
      todayDescription: "مواعيد اليوم وعملياته الجارية",
      patientsTitle: "المرضى",
      patientsDescription: "ملفات المرضى وسجلاتهم",
      appointmentsTitle: "المواعيد",
      appointmentsDescription: "جدولة المواعيد وإدارتها",
      followUpTitle: "المتابعة",
      followUpDescription: "المرضى الذين يحتاجون متابعة أو تواصلًا",
    },
    open: "فتح",
  },
  today: {
    title: "اليوم",
    subtitle: "نظرة عامة على مواعيد اليوم وحالة العمليات",
    emptyTitle: "لا توجد بيانات بعد",
    emptyHint:
      "ستظهر هنا مواعيد اليوم وقوائم الانتظار والحالات الجارية بعد ربط قاعدة البيانات وتشغيل المرحلة التالية من النظام.",
  },
  patients: {
    title: "المرضى",
    subtitle: "ملفات المرضى وبياناتهم الأساسية",
    emptyTitle: "لا يوجد مرضى بعد",
    emptyHint:
      "لم تُضف أي ملفات مرضى حتى الآن. سيتم تفعيل إضافة المرضى والبحث في ملفاتهم في المرحلة التالية من النظام.",
  },
  appointments: {
    title: "المواعيد",
    subtitle: "جدولة المواعيد ومتابعة حالتها",
    emptyTitle: "لا توجد مواعيد بعد",
    emptyHint:
      "لم يتم إنشاء أي مواعيد حتى الآن. سيتم تفعيل إنشاء المواعيد وإدارتها في المرحلة التالية من النظام.",
  },
  followUp: {
    title: "المتابعة",
    subtitle: "قوائم المتابعة والتواصل مع المرضى",
    emptyTitle: "لا توجد قوائم متابعة بعد",
    emptyHint:
      "ستظهر هنا قوائم المتابعة (المستحقة اليوم، قريبًا، المتأخرة، بدون موعد قادم) بعد تفعيل بيانات المرضى والمواعيد.",
    queues: {
      dueToday: "مستحقة اليوم",
      dueSoon: "مستحقة قريبًا",
      overdue: "متأخرة",
      noNextAppointment: "بدون موعد قادم",
      missedAppointments: "مواعيد فائتة",
    },
  },
  errors: {
    generic: "حدث خطأ غير متوقع",
    forbidden: "ليست لديك صلاحية للوصول إلى هذه الصفحة",
    unauthorizedTitle: "جلسة منتهية",
    unauthorizedHint: "انتهت الجلسة أو لم تسجل الدخول. يرجى تسجيل الدخول مرة أخرى.",
    dbNotReadyTitle: "قاعدة البيانات غير متصلة",
    dbNotReadyHint:
      "لم يتم ضبط اتصال قاعدة البيانات بعد. النظام يعمل حاليًا في وضع التأسيس بدون بيانات.",
  },
};

export type Dictionary = typeof ar;

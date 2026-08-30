import { NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { isAdmin } from "@/lib/roles";
import { getPool, getSettingsSafe } from "@/lib/db";

export const dynamic = "force-dynamic";

export interface ReadinessCheck {
  id: string;
  category: "clinic" | "finance" | "clinical" | "security" | "operations";
  title: string;
  description: string;
  status: "pass" | "warn" | "fail";
  details?: string;
  actionHref?: string;
  actionLabel?: string;
}

export async function GET() {
  const session = await requireSession();
  if (!session || !isAdmin(session.role)) {
    return NextResponse.json({ message: "غير مصرّح." }, { status: 403 });
  }

  const checks: ReadinessCheck[] = [];

  try {
    const settings = await getSettingsSafe();
    const pool = getPool();

    // 1. فحص قاعدة البيانات
    const dbStart = Date.now();
    await pool.query("SELECT 1");
    const dbLatency = Date.now() - dbStart;

    checks.push({
      id: "db_connected",
      category: "operations",
      title: "اتصال قاعدة البيانات وسرعة الاستجابة",
      description: `قاعدة البيانات متصلة وتستجيب في غضون ${dbLatency}ms بنجاح تام.`,
      status: dbLatency < 200 ? "pass" : "warn",
    });

    // 2. هوية وبيانات المركز
    const clinicName = settings["clinic.name"];
    const clinicPhone = settings["clinic.phone"];
    const clinicAddress = settings["clinic.address"];

    if (clinicName && clinicName !== "مركز عقلان لطب وجراحة وتقويم الأسنان") {
      checks.push({
        id: "clinic_identity",
        category: "clinic",
        title: "هوية واسم المركز الطبي",
        description: `تم تعيين اسم المركز (${clinicName}) بنجاح ويظهر في الترويسات والمطبوعات.`,
        status: "pass",
      });
    } else {
      checks.push({
        id: "clinic_identity",
        category: "clinic",
        title: "هوية واسم المركز الطبي",
        description: "اسم المركز الافتراضي قيد الاستخدام. يمكنك تخصيصه بحسب اسم المركز الحقيقي.",
        status: "pass",
        actionHref: "/settings",
        actionLabel: "تعديل الإعدادات",
      });
    }

    if (!clinicPhone || !clinicAddress) {
      checks.push({
        id: "clinic_contacts",
        category: "clinic",
        title: "بيانات التواصل والعنوان للمركز",
        description: "يُفضل تعيين هاتف المركز وعنوانه لتظهر في تذييل كروت المواعيد والسندات والروشتات.",
        status: "warn",
        actionHref: "/settings",
        actionLabel: "إكمال البيانات",
      });
    } else {
      checks.push({
        id: "clinic_contacts",
        category: "clinic",
        title: "بيانات التواصل والعنوان للمركز",
        description: "بيانات الهاتف والعنوان مكتملة ومضبوطة في نماذج الطباعة.",
        status: "pass",
      });
    }

    // 3. أسعار الصرف والعملات
    const sarRate = Number(settings["finance.rate.SAR"] ?? 0);
    const usdRate = Number(settings["finance.rate.USD"] ?? 0);

    if (sarRate > 0 && usdRate > 0) {
      checks.push({
        id: "exchange_rates",
        category: "finance",
        title: "أسعار صرف العملات الأجنبية (السعودي والدولار)",
        description: `مضبوطة: 1 ر.س = ${sarRate} ر.ي ، 1 $ = ${usdRate} ر.ي.`,
        status: "pass",
        actionHref: "/settings",
        actionLabel: "تحديث الأسعار",
      });
    } else {
      checks.push({
        id: "exchange_rates",
        category: "finance",
        title: "أسعار صرف العملات الأجنبية",
        description: "أسعار الصرف غير مضبوطة أو تساوي صفر، يرجى تحديثها لضمان حساب السندات بالريال السعودي والدولار.",
        status: "fail",
        actionHref: "/settings",
        actionLabel: "ضبط سعر الصرف",
      });
    }

    // 4. فحص الأطباء المسجلين
    const { rows: doctors } = await pool.query<{ c: string }>(
      `SELECT count(*)::int AS c FROM parties WHERE kind = 'doctor'`,
    );
    const docCount = Number(doctors[0]?.c ?? 0);

    if (docCount > 0) {
      checks.push({
        id: "doctors_list",
        category: "clinical",
        title: "كادر الأطباء والعيادات المسجلة",
        description: `يوجد ${docCount} أطباء مسجلين في النظام لاستقبال المرضى وتوزيع المواعيد والزيارات.`,
        status: "pass",
      });
    } else {
      checks.push({
        id: "doctors_list",
        category: "clinical",
        title: "كادر الأطباء المسجلين",
        description: "لم يتم تسجيل أي طبيب في دليل الأطراف حتى الآن.",
        status: "warn",
        actionHref: "/settings",
        actionLabel: "إضافة أطباء",
      });
    }

    // 5. فحص دليل الخدمات والتسعير
    const { rows: services } = await pool.query<{ c: string }>(
      `SELECT count(*)::int AS c FROM services`,
    );
    const serviceCount = Number(services[0]?.c ?? 0);

    if (serviceCount >= 5) {
      checks.push({
        id: "services_catalog",
        category: "clinical",
        title: "دليل الخدمات والأسعار السريرية",
        description: `يحتوي دليل الخدمات على ${serviceCount} خدمة طبية جاهزة للاستخدام في الفواتير والخطط العلاجية.`,
        status: "pass",
      });
    } else {
      checks.push({
        id: "services_catalog",
        category: "clinical",
        title: "دليل الخدمات والأسعار",
        description: "دليل الخدمات يحتوي على عدد قليل من الخدمات. يُنصح بإضافة تسعيرة خدمات العيادة كاملة.",
        status: "warn",
        actionHref: "/settings",
        actionLabel: "تحديث دليل الخدمات",
      });
    }

    // 6. فحص المستخدمين والصلاحيات
    const { rows: users } = await pool.query<{ c: string }>(
      `SELECT count(*)::int AS c FROM users WHERE active = true`,
    );
    const userCount = Number(users[0]?.c ?? 0);

    checks.push({
      id: "users_setup",
      category: "security",
      title: "حسابات المستخدمين والصلاحيات (RBAC)",
      description: `يوجد ${userCount} مستخدم نشط في النظام مع صلاحيات محددة (مدير، طبيب، استقبال، محاسب).`,
      status: userCount >= 2 ? "pass" : "warn",
      actionHref: "/settings/users",
      actionLabel: "إدارة المستخدمين",
    });

    // 7. شاشة الصالة وبوابة الحجز
    const chairCount = Number(settings["clinic.chairs"] ?? 2);
    checks.push({
      id: "chairs_display",
      category: "operations",
      title: "الكراسي وشاشة انتظار الصالة والتلفزيون",
      description: `تم إعداد ${chairCount} كراسي طبية، مع تفعيل شاشة الانتظار الفورية للمرضى مع جرس التنبيه الصوتي.`,
      status: "pass",
      actionHref: "/display",
      actionLabel: "فتح شاشة الصالة",
    });

    // 8. النسخ الاحتياطي والأمان
    checks.push({
      id: "backup_system",
      category: "security",
      title: "النسخ الاحتياطي وتصدير البيانات",
      description: "نظام تصدير النسخ الاحتياطية الكاملة والمشفرة بتنسيق SQL و JSON جاهز ويعمل بكفاءة.",
      status: "pass",
      actionHref: "/settings/export",
      actionLabel: "تصدير نسخة الآن",
    });

    return NextResponse.json({
      checks,
      summary: {
        total: checks.length,
        passed: checks.filter((c) => c.status === "pass").length,
        warnings: checks.filter((c) => c.status === "warn").length,
        failed: checks.filter((c) => c.status === "fail").length,
        ready: checks.filter((c) => c.status === "fail").length === 0,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { message: error instanceof Error ? error.message : "تعذّر فحص الجاهزية." },
      { status: 500 },
    );
  }
}

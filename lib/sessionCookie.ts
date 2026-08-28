/**
 * اسم كوكي الجلسة ومدتها — معزولان عمدًا عن `lib/auth.ts`.
 *
 * `middleware` يعمل على Edge حيث `node:crypto` غير متاح، فاستيراد الاسم من ملف
 * التجزئة كان يسحب معه المكتبة كلها ويُفشل البناء. الثوابت هنا بلا أي اعتمادية.
 */
export const SESSION_COOKIE = "aqlan_flow_session";
export const SESSION_DURATION_MS = 12 * 60 * 60 * 1000; // وردية يوم كامل

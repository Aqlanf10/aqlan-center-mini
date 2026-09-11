/**
 * نوع سياسة الاحتفاظ كما يُمرَّر بين وحدات النسخ — تجميعٌ صغير حتى لا
 * تستدير lib/backupRetention وlib/backupEngine في دائرة استيراد.
 */
export interface RetentionPolicyLike {
  dailyCount: number;
  weeklyCount: number;
}

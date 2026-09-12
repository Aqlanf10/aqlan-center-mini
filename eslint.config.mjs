import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * حارس الصوابيّة — لا حملةَ تنسيق.
 *
 * أضيف لسببٍ واحدٍ مُثبَت: نداء hook خارج المكوّن يمرّ من `tsc --noEmit` ومن
 * `next build` معًا، ولا تمسكه إلا بوّابة الرسم على HTTP الحقيقي — أي بعد البناء
 * وتشغيل الخادم. قاعدة `rules-of-hooks` تمسكه في ثانية وقبل القيدة.
 *
 * فالقواعد هنا **قواعد أخطاء لا أذواق**: لا مسافات، ولا فواصل، ولا ترتيب استيراد.
 * كل قاعدة مفعَّلة تصف عطبًا يظهر في التشغيل، لا اختلافًا في الشكل.
 */
export default tseslint.config(
  {
    ignores: [
      "node_modules/**", ".next/**", "next-env.d.ts",
      "**/*.mjs", "**/*.d.mts", "public/**", "schema/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs["recommended-latest"],
  {
    /* إضافةُ Next مسجَّلةٌ لسببٍ واحد: ملفاتٌ في المستودع تحمل تعطيلًا سطريًّا
       لقاعدةٍ منها، وقاعدةٌ غير معرَّفة تُعدّ خطأً في ESLint 9. تسجيلها يجعل
       التعطيل السطريّ مفهومًا بدل أن نحذفه من عشرة ملفات لا شأن لها بهذه المرحلة. */
    plugins: { "@next/next": next },
    rules: {
      /* الأصل: قواعد الـhooks — سبب إضافة الأداة كلّها. */
      "react-hooks/rules-of-hooks": "error",
      /* الاعتماديات الناقصة تُبلَّغ ولا تُفشل: إصلاحها الجارف يغيّر سلوك شاشاتٍ
         تعمل اليوم، وذلك عملٌ مستقلّ لا يُخلط ببناء منصّة الإعدادات. */
      "react-hooks/exhaustive-deps": "warn",

      /* أخطاء صوابيّة عامّة. */
      "no-constant-condition": "error",
      "no-dupe-keys": "error",
      "no-unreachable": "error",
      "@typescript-eslint/no-floating-promises": "off",

      /* رصدَ هذا القاعدةُ الجديدة ثمانيةَ مواضع تُحدِّث الحالة داخل تأثيرٍ
         مباشرةً. ليست أعطالًا قائمة — الشاشات تعمل — لكنها رسمٌ متتابع يستحقّ
         المراجعة. تبقى تحذيرًا لأن إصلاحها الجارف يغيّر سلوك شاشاتٍ تعمل اليوم،
         وذاك عملٌ مستقلّ لا يُخلط ببناء منصّة الإعدادات. */
      "react-hooks/set-state-in-effect": "warn",

      /* ضجيجٌ لا يصف عطبًا في هذا المستودع. */
      "@next/next/no-img-element": "off",
      "no-useless-escape": "warn",
      "no-control-regex": "warn",
      "no-irregular-whitespace": "warn",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none",
      }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-undef": "off",
    },
  },
);

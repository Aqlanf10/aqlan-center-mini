/**
 * علامة «نسخة معاد طباعتها».
 *
 * تُصيَّر دائمًا وتظهر بشرطين: أن يقول الخادم إن المستند طُبع من قبل، أو أن يكشفها
 * زرّ الطباعة عند إعادة. وهي مائلة عبر الورقة كلها لا في زاوية: من ينظر إلى السند
 * بسرعة يجب أن يراها بلا أن يبحث عنها.
 */
export function ReprintMark({ printed = false }: { printed?: boolean }) {
  return (
    <div className={`reprint-mark${printed ? " reprint-mark-on" : ""}`} aria-hidden>
      نسخة معاد طباعتها
    </div>
  );
}

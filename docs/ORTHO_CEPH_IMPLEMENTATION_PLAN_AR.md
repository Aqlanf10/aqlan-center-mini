# خطة تنفيذ التقويم والسيفالو ومصفوفة القبول

المرجع الحالي: البرومبت الكامل ذو 624 سطرًا و126204 بايت، وبصمته 5c12afbbc222df0a511c73ce5e16b0ffa089a006d7d7f29cd74bab2307e4daeb.

مصدر القراءة 1594c91d، وخلف التكامل الحالي 535668b7. الحزم المصدرية ليست دليل تشغيل. لا يوجد اختبار قبول مكتمل دون دليل CI وStaging مناسب.

## ثوابت التسليم

- خمسة أقسام رئيسية تشمل الخطوات الداخلية الثلاث عشرة كاملة.
- العنوان «دراسة حالة تقويم — [اسم المريض]»، والقالب «عرض الحالة الكامل»، والهوية من إعدادات المركز.
- دراسة داخلية محفوظة عبر الأجهزة، وإصدارات موثقة ثابتة، وتصدير PPTX قابل للتحرير وPDF اختياريان من لقطة واحدة.
- القياسات تدخل مرة واحدة، والتعديلات لكل استخدام للصورة، والأصل وإحداثيات السيفالو مستقلان.
- مصدر دين مالي واحد؛ لا تظهر اتفاقات أو ضمانات أو أقساط في العرض العلمي الافتراضي.

## نقطة التحقق الحالية

- Ceph safety V4: implemented awaiting verification. independently source-clear; CI/PG/native pending; V1–V3 superseded. Manifest SHA256: 18fec7f1f7d7d2a5dde2c2a61151af7740c75c810f01c58fddaf728c77b0ee7d
- Five-section navigation V7: implemented awaiting verification. bounded assessment handshake reviewed; full nav review and execution pending. Manifest SHA256: cda54efb05b698ebc7d39607797f1889687c878c5c84b23dbb5dd64580aae72f
- Schema2 pure measurement foundation: implemented awaiting verification. pure DTO independently reviewed; persistence separate. Manifest SHA256: a44664337bfe81d7204b4d7b240ce52f5c0f6b1b1c81213276c659e8b70b4335
- Schema2 measurement UI V3: implemented awaiting verification. independently source-clear; no actual execution or writer integration. Manifest SHA256: a5c1872c82fb95cb790461cf9ce88d997c869bd9f911291781b5f2760547b17a
- Canonical financial display adapter V2: implemented awaiting verification. foundation only; O41–49 are not completed. Manifest SHA256: 89af23246f10ade27db09a83f38afb8de7197334df9fae163b9a817db394d4c2

الخطوة التالية: التحقق التنفيذي من حزمة أمان السيفالو V4، واستكمال عقد ووحدة تحويل الصور لكل استخدام، مع استمرار الكاتب المنظم للتقييم وسجل الدراسة والتثبيت.

## المتطلبات التفصيلية

### V2R069 — أ. شروط البداية والتوافق مع العمل الحالي

المطلب: 1. اقرأ `AGENTS.md` والوثائق الحالية والخطة الشاملة إن كانت موجودة. اتبع توجيهاته الخاصة بإصدار Next.js المثبت؛ اقرأ الأدلة المحلية ذات الصلة قبل كتابة الكود.

الملكية: lead + root integration
المسارات: AGENTS.md; lib/db.ts; migrations; schema
القبول المطلوب: source inventory / existing regression suite
الحالة: in progress
التفصيل: partial_source_verified
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R070 — أ. شروط البداية والتوافق مع العمل الحالي

المطلب: 2. ثبّت SHA البداية، وافحص تغييرات `main` والفروع #319 و#322 وقاعدة الدمج الفعلية لـ#320. أنشئ جدول «موجود / يحتاج تعديل / جديد / غير متحقق». لا تستنتج غياب وظيفة من اسم PR أو وثيقة فقط.

الملكية: lead + root integration
المسارات: AGENTS.md; lib/db.ts; migrations; schema
القبول المطلوب: source inventory / existing regression suite
الحالة: in progress
التفصيل: partial_source_verified
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R071 — أ. شروط البداية والتوافق مع العمل الحالي

المطلب: 3. افحص محليًا `lib/db.ts`، عقود المخطط والترحيلات، قيود الحالة والزيارات والمرضى، ومسارات الوثائق والصلاحيات والتدقيق والماليات. لا تكتب ترحيلات اعتمادًا على أسماء مقترحة في هذه الوثيقة دون مطابقتها بالمخطط الحقيقي.

الملكية: lead + root integration
المسارات: AGENTS.md; lib/db.ts; migrations; schema
القبول المطلوب: source inventory / existing regression suite
الحالة: in progress
التفصيل: partial_source_verified
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R072 — أ. شروط البداية والتوافق مع العمل الحالي

المطلب: 4. قبل تعديل الحالة، وثّق الفرق بين معرف `ortho_cases` ومعرف `clinical_cases` وروابط الخطط والجلسات والوثائق والتحليلات. لا تستخدم أحد المعرفين مكان الآخر لأن الاسم `caseId` متشابه.

الملكية: lead + root integration
المسارات: AGENTS.md; lib/db.ts; migrations; schema
القبول المطلوب: source inventory / existing regression suite
الحالة: in progress
التفصيل: partial_source_verified
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R073 — أ. شروط البداية والتوافق مع العمل الحالي

المطلب: 5. حافظ على ربط خط الأساس القديم، حماية المسودات، منع تكرار الشدّة، عزل حالة المريض، حماية الصور، مسار اعتماد السيفالو، وإصلاحات التنقل الحالية. أضف اختبارات انحدار لهذه الحدود قبل إعادة تفكيك المكونات.

الملكية: lead + root integration
المسارات: AGENTS.md; lib/db.ts; migrations; schema
القبول المطلوب: source inventory / existing regression suite
الحالة: in progress
التفصيل: partial_source_verified
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R074 — أ. شروط البداية والتوافق مع العمل الحالي

المطلب: 6. لا تغيّر خدمات الإنتاج أو أسرارها أو بياناتها. طوّر واختبر على Staging مستقلة كما في القسم الخاص بالتشغيل. مراجعة هذه الوثيقة ليست إذنًا لنشر غير متحقق إلى الإنتاج.

الملكية: lead + root integration
المسارات: AGENTS.md; lib/db.ts; migrations; schema
القبول المطلوب: source inventory / existing regression suite
الحالة: in progress
التفصيل: partial_source_verified
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R086 — ب. تجربة الاستخدام المستهدفة

المطلب: | 1 | الوصول وبيانات التعريف | استدعاء المريض والحالة والموعد والطبيب والفرع دون تسجيل المريض مرة ثانية؛ تحديد حالة جديدة/قديمة/محولة |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R087 — ب. تجربة الاستخدام المستهدفة

المطلب: | 2 | المقابلة والشكوى | الشكوى الرئيسية بكلام المريض، التوقعات، التاريخ الطبي والسني والعائلي والتقويمي والعادات؛ اقتراح حقول منظمة دون اختراع إجابات |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R088 — ب. تجربة الاستخدام المستهدفة

المطلب: | 3 | الفحص خارج الفم | الصور والفحص الأمامي والجانبي والابتسامة والتناسق والنسب والأنسجة الرخوة والوظائف، مع حقول القياس والملاحظات |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R089 — ب. تجربة الاستخدام المستهدفة

المطلب: | 4 | الفحص داخل الفم | الأسنان والعلاقات الإطباقية لكل جانب، overjet/overbite، الخطوط الوسطية، التزاحم/التباعد، curve of Spee، والصور والنتائج الأخرى |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R090 — ب. تجربة الاستخدام المستهدفة

المطلب: | 5 | القياسات وتحليل الموديلات | إدخال أحجام الأسنان وقياسات القوس مرة واحدة على نموذج واضح للفكين؛ اختيار تحليل أو عدة تحليلات وتشغيلها تلقائيًا من هذه البيانات |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R091 — ب. تجربة الاستخدام المستهدفة

المطلب: | 6 | البانوراما | ربط الصورة الأصلية وتاريخها، وفحص الطبيب ونتائجه وتعليقاته المرتبطة بالأسنان؛ لا تُستنتج نتيجة شعاعية من اسم الملف |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R092 — ب. تجربة الاستخدام المستهدفة

المطلب: | 7 | السيفالو | الصورة والتاريخ والمرحلة والمعايرة والمعالم ثم الحساب والتفسير والمراجعة والاعتماد، في سياق الحالة نفسها |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R093 — ب. تجربة الاستخدام المستهدفة

المطلب: | 8 | خلاصة التشخيص وقائمة المشكلات | تجميع الملاحظات والقياسات والتحليلات والصور مع مصادرها، ثم مراجعة الطبيب وصياغة التشخيص واعتماده |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R094 — ب. تجربة الاستخدام المستهدفة

المطلب: | 9 | الأهداف وخطة العلاج والميكانيكا | أهداف وبدائل وإجراءات واستراتيجيات وإرساء وخطة مسافات وموافقات مرتبطة بالمشكلات |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R095 — ب. تجربة الاستخدام المستهدفة

المطلب: | 10 | الاتفاق المالي والموافقة | تحديد نطاق الاتفاق والمبلغ والعملة والخصم والدفعة والأقساط وربط الفاتورة؛ توثيق ما سُدد سابقًا للحالة القديمة وإصدار نسخة الاتفاق |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R096 — ب. تجربة الاستخدام المستهدفة

المطلب: | 11 | التركيب والزيارات والتحصيل | تسجيل ما نُفذ وصوره ومتابعته، وربط كل عمل بتغطية الاتفاق أو قرار مالي مستقل؛ تحصيل المستحق عبر الحساب القائم دون إعادة المقابلة كل مرة |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R097 — ب. تجربة الاستخدام المستهدفة

المطلب: | 12 | النتيجة والإنهاء والتثبيت | تقييم الأهداف، فك الجهاز والمثبتات لكل فك والتعليمات وزيارات الاستبقاء؛ عرض الوضع المالي النهائي مستقلًا عن القرار السريري |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R098 — ب. تجربة الاستخدام المستهدفة

المطلب: | 13 | دراسة الحالة الموثقة داخل البرنامج | عرض متكامل باسم المركز والمريض يُحفظ ويُراجع داخل الحالة، مع تعبئة محتواه من السجل؛ تصدير PPTX أو PDF اختياري عند الطلب |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R102 — ب. تجربة الاستخدام المستهدفة

المطلب: - أزرار «السابق» و«حفظ والمتابعة» ومؤشر خطوات واضح؛ يمكن الرجوع لأي جزء وتسجيل مسودة أو تخطي جزء غير متاح مع إظهار النقص. لا تحبس الطبيب في معالج خطي يمنع تقديم الرعاية.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R103 — ب. تجربة الاستخدام المستهدفة

المطلب: - المرحلة التالية تستفيد من بيانات السابقة تلقائيًا. لكل قيمة وصورة ونتيجة مالك واحد، ويُفتح مصدرها للتعديل من الملخص أو العرض.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R104 — ب. تجربة الاستخدام المستهدفة

المطلب: - الحالة الجديدة تبدأ بالمقابلة، والحالة القديمة تبدأ بتحديد الوضع الحالي وما توفر من الأرشيف، والزيارة الدورية تفتح نموذج الزيارة المختصر. لا يُجبر العائد على إعادة إعداد الحالة.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R105 — ب. تجربة الاستخدام المستهدفة

المطلب: - أظهر حالة كل خطوة: لم تبدأ / مسودة / مكتملة المدخلات / تحتاج مراجعة / معتمدة حيث ينطبق الاعتماد. اكتمال الحقول ليس اعتمادًا سريريًا.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R106 — ب. تجربة الاستخدام المستهدفة

المطلب: - ترتيب إدخال البيانات هو الترتيب أعلاه حسب طلب المالك؛ قالب دراسة الحالة الخاص بالمركز يحتفظ بتوزيع وترتيب شرائحه المرجعية المحددين في القسم «ل». اختلاف موضع إدخال القياس عن موضع شريحته لا يسبب إعادة الإدخال أو إعادة ترتيب يدوي.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R107 — ب. تجربة الاستخدام المستهدفة

المطلب: - صورة غير متاحة لا تُنشأ بالتخمين، وخانة أشعة فارغة لا تتحول إلى طلب أشعة آلي. وجود خطوات البانوراما والسيفالو لا يفرض تكرار التصوير في كل زيارة.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R108 — ب. تجربة الاستخدام المستهدفة

المطلب: - أتح معاينة عرض الحالة منذ الخطوات الأولى كمسودة تُستكمل تدريجيًا؛ لا يشترط الوصول للتثبيت لتصدير عرض تقدم.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R116 — ب. تجربة الاستخدام المستهدفة

المطلب: | ملخص الحالة والجلسة | الحساسية والتنبيهات، المرحلة، الجهاز والأسلاك الحالية، آخر إجراء، الموعد القادم، زر تسجيل الزيارة | قائمة العمل اليوم، الخط الزمني، الاستحقاقات والنواقص |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R117 — ب. تجربة الاستخدام المستهدفة

المطلب: | السجلات والتشخيص | صور الحالة حسب التاريخ والمرحلة، الفحص، السيفالو، الموديلات | المعايرة والتحليل والمقارنة والتشخيص المعتمد ومصادره |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R118 — ب. تجربة الاستخدام المستهدفة

المطلب: | الخطة والميكانيكا والاتفاق | المشكلة والهدف وخطة المعالجة والتقدم، وملخص الاتفاق بحسب الصلاحية | البدائل، الإرساء، المسافات، الأجهزة والإحالات، ثم الاتفاق المالي والأقساط والفاتورة من مصدرها الأصلي |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R119 — ب. تجربة الاستخدام المستهدفة

المطلب: | الإنهاء والتثبيت | حالة كل فك، المثبتات، آخر مراجعة والاستحقاق القادم | فك الجهاز، التسليم والتعليمات، الإصلاحات والانتكاس وإغلاق الحالة |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R120 — ب. تجربة الاستخدام المستهدفة

المطلب: | عرض الحالة | اكتمال العرض ومعاينة الشرائح | اختيار السجلات والقالب واللغة والخصوصية والتصدير والإصدارات |

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R124 — ب. تجربة الاستخدام المستهدفة

المطلب: - شريط واحد ثابت لاسم/رقم المريض والحالة والطبيب والفرع والتحذيرات السريرية الأساسية. لا تكرر بطاقات ضخمة للمعلومات نفسها.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R125 — ب. تجربة الاستخدام المستهدفة

المطلب: - شاشة «زيارة اليوم» هي المدخل الافتراضي للحالة الجارية؛ لا تطلب إعادة ملء ملف التشخيص في كل شدّة.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R126 — ب. تجربة الاستخدام المستهدفة

المطلب: - هدف قبول الاستخدام: بدء مسودة زيارة من الحالة بنقرتين على الأكثر؛ الوصول للسيفالو أو عرض الحالة بنقرتين على الأكثر. القياس لا يشمل كتابة البيانات أو اختيار ملف من الجهاز.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R127 — ب. تجربة الاستخدام المستهدفة

المطلب: - حفظ المسودة وإظهار «محفوظ/جارٍ الحفظ/تعارض/تعذر تأكيد الحفظ» بوضوح. لا يظهر نجاح قبل تأكيد الخادم؛ انقطاع الرد لا يبرر إعادة إنشاء الزيارة.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R128 — ب. تجربة الاستخدام المستهدفة

المطلب: - تغيير المريض أو الحالة أو الصلاحية أثناء طلب جارٍ لا يُظهر الرد في سياق آخر. لا تُحفظ بيانات صحية في localStorage غير منضبط لإبقاء المسودات.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R129 — ب. تجربة الاستخدام المستهدفة

المطلب: - العربية أساسية والإنجليزية ثانوية باستخدام نظام ترجمة مركزي؛ أسماء القياسات ومقاسات الأسلاك والمعادلات تعرض باتجاه مناسب. لا تُترجم الملاحظات السريرية تلقائيًا باعتبار الترجمة أصلًا معتمدًا.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R130 — ب. تجربة الاستخدام المستهدفة

المطلب: - أعد استخدام هوية المركز وإعدادات الشعار والألوان والطباعة واسم الطبيب وحقوقه، مع صلاحيات تعديل واضحة. لا تضع بيانات المركز أو شعاره نصوصًا ثابتة موزعة في المكونات.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R131 — ب. تجربة الاستخدام المستهدفة

المطلب: - اكتمال الأرشيف لا يُشترط لتسجيل زيارة ضرورية. يظهر النقص محددًا، وتُمنع فقط العمليات التي تحتاج فعلًا هذه البيانات، مثل اعتماد قياس غير معاير.

الملكية: guided UI owner
المسارات: components/PatientOrtho.tsx; components/OrthoCaseJourney.tsx; lib/ortho-case-journey.ts
القبول المطلوب: O01 O04 O05 O38 O50 O51;390/768/1440 +1280
الحالة: in progress
التفصيل: requires_five_section_successor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R139 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | بيانات المريض والتاريخ الطبي والتنبيهات | السجل العام الموجود | قراءة موحدة؛ أي تعديل يعود للمصدر نفسه |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R140 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | حالة التقويم | `ortho_cases` وربطها بسياق الحالة السريرية الموجود | حلقة علاج محددة؛ إعادة العلاج حلقة منفصلة بروابط واضحة، وليست مسحًا للتاريخ |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R141 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | تقييم التقويم | امتداد منظم للتقييم/التشخيص الموجود، بعد الجرد | مسودات ونسخ معتمدة؛ كل معلومة لها تاريخ ومصدر ومؤلف |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R142 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | المشكلة والهدف | كيانات قابلة للربط بخطة العلاج الأصلية | مشكلة واحدة قد ترتبط بعدة أهداف وإجراءات؛ لا نسخ منفصلة غير متزامنة |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R143 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | خطة الميكانيكا | امتداد سريري للخطة المعتمدة الحالية | نسخ، بدائل، قرار الطبيب، نطاق الأسنان/الفك، وسبب التغيير |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R144 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | الزيارة والتنفيذ | الزيارة والجلسة و`ortho_adjustments` القائمة | حدث واحد مرتبط؛ حجز الموعد لا يساوي تنفيذ العمل، والتوقيع لا يُنشئ تحصيلًا |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R145 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | مجموعة السجلات | مجموعة زمنية تشير إلى المستندات الحالية | نوع المنظر والمرحلة وتاريخ الالتقاط ومصدره؛ لا نسخ ثنائية متكررة للصور |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R146 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | السيفالو | الدراسة الحالية وصورة المصدر ومعالمها ومعايرتها وإصدارات الاعتماد | الفرق صريح بين الدراسة على صورة واحدة، والتصحيح، وصورة متابعة جديدة |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R147 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | تحليل الموديل | جلسة تحليل وقياسات أصلية ونتيجة بإصدار | كل فك وأسنان ومصدر قياس مستقل؛ الربط بالحالة والسجل والتشخيص |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R148 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | المساحات والإجراءات | خطة المسافات ثم سجل التنفيذ | المخطط والمتوقع والمقاس والمنفذ قيم مختلفة |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R149 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | التثبيت | أحداث فك وتسليم ومراجعة وجهاز لكل فك | يسمح بأكثر من مثبت في الفك نفسه، وباستبدال الجهاز دون محو سابقه |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R150 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: | العرض | تعريف قالب واختيارات وسجل توليد ولقطة مصادر | منتج مشتق للعرض؛ ليس سجلًا سريريًا ثانيًا قابلًا لتحرير الحقائق الأصلية |

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R154 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: - كل كيان تابع للحالة يحمل أو يتحقق عبر العلاقات من هوية المريض والحالة والفرع ونطاق الصلاحية. لا تثق بمعرفات الواجهة.

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R155 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: - في القياسات: القيمة والوحدة والجهة/الفك والسن/المسافة والتاريخ والمصدر وطريقة القياس؛ `null` غير الصفر. حالات «غير مقاس/غير معروف/لا ينطبق/غير متاح بسبب الصلاحية» متمايزة.

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R156 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: - فرّق `occurredOn`، أي التاريخ السريري، عن `recordedAt`، أي وقت الإدخال. التاريخ القديم المجهول يظل مجهولًا مع وصف مصدره، ولا يُستبدل بتاريخ اليوم.

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R157 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: - استخدم معرفًا ثابتًا للحدث وإصدارًا للتحرير. ترتيب الزيارة المعروض يُحسب ولا يُستخدم مفتاحًا ولا يغيّر هويتها عند إدخال زيارة قديمة.

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R158 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: - التصحيح بعد الاعتماد إصدار أو ملحق موثق بالسبب والمؤلف والتاريخ، لا تعديل صامت للسجل المعتمد.

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R159 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: - ابدأ بترحيلات إضافية وتعبئة قابلة للاستئناف مع تقرير السجلات الملتبسة. لا تربط سجلًا قديمًا بالحالة الحالية لمجرد أنها الحالة الوحيدة المفتوحة.

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R160 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: - قواعد التزامن في الخادم والمعاملة وقاعدة البيانات: مفاتيح تكرار للإنشاء، فحص الإصدار عند التعديل، وتعارض واضح عند تعديل طبيبين السجل نفسه. لا يكفي تعطيل الزر في المتصفح.

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R161 — ج. مصدر واحد للحقيقة ونموذج البيانات

المطلب: - افصل خدمات المجال والحساب والعرض. لا تنقل التعقيد من `PatientOrtho.tsx` إلى ملف عملاق آخر، ولا تغيّر طبقة البيانات كاملة في PR تجميلي.

الملكية: lead + domain owners
المسارات: lib/db.ts; assessment/strategy/journey stores; dedicated proposed media schema
القبول المطلوب: O03 O04 O05 O06 O07 O22 O28 O30
الحالة: in progress
التفصيل: partial_requires_explicit_contracts
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R167 — د. التقييم الأولي وملف التشخيص

المطلب: 1. الشكوى الرئيسية بكلام المريض، التوقعات، الإحالة، وتاريخ التقويم السابق. حالة جديدة أو مستمرة من قبل النظام أو محولة من طبيب آخر.

الملكية: assessment owner + UI owner
المسارات: lib/ortho-assessment*.ts; components/OrthoCaseAssessment.tsx; PatientDiagnosis
القبول المطلوب: O01 O02 O04 O13 O17 O24
الحالة: in progress
التفصيل: 0052V3_partial_unexecuted
المانع المحدد: Frozen schema1 V3 is superseded for integration by patient-first ordering/schema2 successor; no current deadlock was established. Clinical approval capability and runtime remain under review.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R168 — د. التقييم الأولي وملف التشخيص

المطلب: 2. التاريخ الطبي والسني والعائلي والعادات والوظائف ذات الصلة والتنبيهات. حقول منضبطة مع مساحة ملاحظات، لا عشرات الحقول الإلزامية بلا حاجة.

الملكية: assessment owner + UI owner
المسارات: lib/ortho-assessment*.ts; components/OrthoCaseAssessment.tsx; PatientDiagnosis
القبول المطلوب: O01 O02 O04 O13 O17 O24
الحالة: in progress
التفصيل: 0052V3_partial_unexecuted
المانع المحدد: Frozen schema1 V3 is superseded for integration by patient-first ordering/schema2 successor; no current deadlock was established. Clinical approval capability and runtime remain under review.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R169 — د. التقييم الأولي وملف التشخيص

المطلب: 3. تقييم النمو يسجله الطبيب وطريقة تقييمه وتاريخه؛ العمر وحده لا يتحول إلى نتيجة مؤكدة، والعمر المجهول لا يعني أن المريض في طور النمو.

الملكية: assessment owner + UI owner
المسارات: lib/ortho-assessment*.ts; components/OrthoCaseAssessment.tsx; PatientDiagnosis
القبول المطلوب: O01 O02 O04 O13 O17 O24
الحالة: in progress
التفصيل: 0052V3_partial_unexecuted
المانع المحدد: Frozen schema1 V3 is superseded for integration by patient-first ordering/schema2 successor; no current deadlock was established. Clinical approval capability and runtime remain under review.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R170 — د. التقييم الأولي وملف التشخيص

المطلب: 4. الفحص خارج الفم: أمامي وجانبي، التناسق والخطوط الوسطية، الثلثيات، الابتسامة، ظهور القواطع واللثة، الممرات الشدقية، الشفتان والأنسجة الرخوة. القياس يختلف عن الملاحظة النصية.

الملكية: assessment owner + UI owner
المسارات: lib/ortho-assessment*.ts; components/OrthoCaseAssessment.tsx; PatientDiagnosis
القبول المطلوب: O01 O02 O04 O13 O17 O24
الحالة: in progress
التفصيل: 0052V3_partial_unexecuted
المانع المحدد: Frozen schema1 V3 is superseded for integration by patient-first ordering/schema2 successor; no current deadlock was established. Clinical approval capability and runtime remain under review.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R171 — د. التقييم الأولي وملف التشخيص

المطلب: 5. الفحص داخل الفم: مرحلة الأسنان، مخطط الأسنان القائم، علاقة الأرحاء والأنياب لكل جانب، overjet وoverbite بوحداتهما، crowding/spacing لكل فك، curve of Spee، العضة المتصالبة/المقصية/المفتوحة، الدورانات والانطمار والفقد والتسوس ودواعم السن.

الملكية: assessment owner + UI owner
المسارات: lib/ortho-assessment*.ts; components/OrthoCaseAssessment.tsx; PatientDiagnosis
القبول المطلوب: O01 O02 O04 O13 O17 O24
الحالة: in progress
التفصيل: 0052V3_partial_unexecuted
المانع المحدد: Frozen schema1 V3 is superseded for integration by patient-first ordering/schema2 successor; no current deadlock was established. Clinical approval capability and runtime remain under review.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R172 — د. التقييم الأولي وملف التشخيص

المطلب: 6. عوامل الخطورة ومشكلات الصحة الفموية التي تستدعي معالجة أو إحالة للتخصص الآخر. الإحالة مرتبطة بخطة المريض العامة وتُرى نتيجتها في التقويم.

الملكية: assessment owner + UI owner
المسارات: lib/ortho-assessment*.ts; components/OrthoCaseAssessment.tsx; PatientDiagnosis
القبول المطلوب: O01 O02 O04 O13 O17 O24
الحالة: in progress
التفصيل: 0052V3_partial_unexecuted
المانع المحدد: Frozen schema1 V3 is superseded for integration by patient-first ordering/schema2 successor; no current deadlock was established. Clinical approval capability and runtime remain under review.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R173 — د. التقييم الأولي وملف التشخيص

المطلب: 7. سجل تشخيص بإصدار يجمع الاستنتاج السريري ومصادر الصور والموديلات والسيفالو؛ لا يُكتب التشخيص النهائي من معادلة واحدة.

الملكية: assessment owner + UI owner
المسارات: lib/ortho-assessment*.ts; components/OrthoCaseAssessment.tsx; PatientDiagnosis
القبول المطلوب: O01 O02 O04 O13 O17 O24
الحالة: in progress
التفصيل: 0052V3_partial_unexecuted
المانع المحدد: Frozen schema1 V3 is superseded for integration by patient-first ordering/schema2 successor; no current deadlock was established. Clinical approval capability and runtime remain under review.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R174 — د. التقييم الأولي وملف التشخيص

المطلب: 8. قائمة مشاكل منظمة: الفئة، الوصف، السن/الأسنان أو الفك أو الجانب، المصدر، الشدة إن قيّمها الطبيب، الأولوية، وحالة المعالجة. أضف الهدف القابل للتقييم والنتيجة اللاحقة دون إجبار الطبيب على أهداف رقمية غير مناسبة.

الملكية: assessment owner + UI owner
المسارات: lib/ortho-assessment*.ts; components/OrthoCaseAssessment.tsx; PatientDiagnosis
القبول المطلوب: O01 O02 O04 O13 O17 O24
الحالة: in progress
التفصيل: 0052V3_partial_unexecuted
المانع المحدد: Frozen schema1 V3 is superseded for integration by patient-first ordering/schema2 successor; no current deadlock was established. Clinical approval capability and runtime remain under review.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R178 — هـ. السجلات والصور والموديلات

المطلب: - وفر قالب الصور الأساسي المماثل لـA3 وA9: الوجه في الراحة والابتسامة والبروفايل، وثلاث صور إطباق أمامية/جانبية، وصورتي إطباق علوي وسفلي؛ اسمح بزوايا إضافية حسب الحالة.

الملكية: media owner pending / lead contract
المسارات: patient_documents; lib/ortho-records.ts; WebCephRecordsGrid; proposed group/transform store
القبول المطلوب: O03 O09 O32 O33 O34 O36 O37
الحالة: in progress
التفصيل: existing_documents_partial_new_groups_editor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R179 — هـ. السجلات والصور والموديلات

المطلب: - أضف البانوراما والسيفالو وصور الموديلات وملفات المسح كمستندات من نوعها. رفع STL/PLY أو صيغة أخرى لا يعني توافر قياس ثلاثي الأبعاد صحيح؛ لا تعلن ذلك دون قارئ ومعايرة واختبار مستقلين.

الملكية: media owner pending / lead contract
المسارات: patient_documents; lib/ortho-records.ts; WebCephRecordsGrid; proposed group/transform store
القبول المطلوب: O03 O09 O32 O33 O34 O36 O37
الحالة: in progress
التفصيل: existing_documents_partial_new_groups_editor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R180 — هـ. السجلات والصور والموديلات

المطلب: - مجموعة تصوير واحدة لها تاريخ ومرحلة ومعرف، وتسمح بأكثر من صورة للمنظر نفسه مع اختيار المفضلة. لا تبنِ مجموعة وهمية من أحدث صورة لكل منظر التُقطت في تواريخ مختلفة دون إظهار ذلك.

الملكية: media owner pending / lead contract
المسارات: patient_documents; lib/ortho-records.ts; WebCephRecordsGrid; proposed group/transform store
القبول المطلوب: O03 O09 O32 O33 O34 O36 O37
الحالة: in progress
التفصيل: existing_documents_partial_new_groups_editor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R181 — هـ. السجلات والصور والموديلات

المطلب: - قبل/أثناء/بعد/تثبيت وصف للسجل الذي يختاره الطبيب؛ لا يُستنتج فقط من تاريخ رفعه أو مرحلة الحالة الحالية. أظهر كل تاريخ داخل المقارنات.

الملكية: media owner pending / lead contract
المسارات: patient_documents; lib/ortho-records.ts; WebCephRecordsGrid; proposed group/transform store
القبول المطلوب: O03 O09 O32 O33 O34 O36 O37
الحالة: in progress
التفصيل: existing_documents_partial_new_groups_editor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R182 — هـ. السجلات والصور والموديلات

المطلب: - احتفظ بالأصل، وأنشئ نسخ عرض مناسبة دون تشويه النسب. القص والتدوير والتعليقات لا يغيرون ملف الأصل ولا إحداثيات القياس المعتمد.

الملكية: media owner pending / lead contract
المسارات: patient_documents; lib/ortho-records.ts; WebCephRecordsGrid; proposed group/transform store
القبول المطلوب: O03 O09 O32 O33 O34 O36 O37
الحالة: in progress
التفصيل: existing_documents_partial_new_groups_editor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R183 — هـ. السجلات والصور والموديلات

المطلب: - نقص الصور، فشل التحميل، وسحب صلاحية الصور ثلاث حالات مختلفة. لا يظهر «السجلات مكتملة» لمن لا يملك قراءة مصادرها.

الملكية: media owner pending / lead contract
المسارات: patient_documents; lib/ortho-records.ts; WebCephRecordsGrid; proposed group/transform store
القبول المطلوب: O03 O09 O32 O33 O34 O36 O37
الحالة: in progress
التفصيل: existing_documents_partial_new_groups_editor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R184 — هـ. السجلات والصور والموديلات

المطلب: - إرفاق صورة بزيارة قديمة يربطها بالحدث المقصود؛ رفعها اليوم لا يجعلها صورة اليوم. لا تعد رفع الصورة نفسها لكل جزء من التقرير.

الملكية: media owner pending / lead contract
المسارات: patient_documents; lib/ortho-records.ts; WebCephRecordsGrid; proposed group/transform store
القبول المطلوب: O03 O09 O32 O33 O34 O36 O37
الحالة: in progress
التفصيل: existing_documents_partial_new_groups_editor
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R194 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 1. أصلح/أكمل عمل #319 بعد مراجعته مع #320؛ لا تعِد إنشاء ميزته في فرع منافس. وثّق أصل نسخة التصحيح والربط الصريح بخط الأساس ودراسة المتابعة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R195 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 2. T1 قبل العلاج، T2 أثناءه، T3 بعد إنهاء العلاج، T4 متابعة التثبيت، مع أكثر من دراسة في المرحلة إذا وجدت. هذه تصنيفات سجلات، وليست جدول أشعة إلزاميًا ولا وصفًا آليًا يتغير بتغيير مرحلة الحالة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R196 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 3. للحالة القديمة قد لا يوجد T1؛ أظهر «غير متاح قبل بدء العلاج»، ولا تُسمِّ صورة أُخذت بعد بدء العلاج «قبل العلاج». اختيار خط أساس للمقارنة يجب أن يوضح ما يمثله.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R197 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 4. المعايرة والمعالم مرتبطتان بصورة المصدر وأبعادها وتحويلاتها. تُرفض المعايرة الصفرية أو غير الصالحة، وتظهر الوحدات؛ لا تُحسب أطوال بالمليمتر من صورة غير معايرة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R198 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 5. النقاط المقترحة آليًا أو هندسيًا تحمل مصدرًا وحالة مراجعة. لا تعرض نقطة مشتقة من أبعاد الصورة كأنها معلم رصده تحليل فعلي للصورة. اعتماد الطبيب مطلوب وفق سياسة واضحة للمعالم المستخدمة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R199 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 6. جدول القياسات: رمز واسم، مجموعة، وحدة، قيمة، معالم لازمة، مرجع وإصداره، نتيجة تفسير مبدئية. غياب معلم لا يعطي صفرًا أو قراءة طبيعية.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R200 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 7. أنشئ خريطة بين صفوف A14 ورموز القياسات المتاحة بالفعل: الموجود، مختلف التعريف، غير المتاح، والوحدة. لا تساوِ القياسات المتشابهة لفظًا ذات المستويات أو العلامات المختلفة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R201 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 8. المراجع المعيارية تحفظ الاسم والإصدار ومصدرًا موثوقًا وحدود التطبيق. لا تتغير الدراسة المعتمدة بأثر رجعي عند تعديل المرجع. قبل إضافة صيغة أو معيار جديد، وثّق مرجعه العلمي الأصلي وأمثلة تحقق مستقلة ومراجعة الأخصائي.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R202 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 9. افصل نتائج القياس عن توصيات العلاج. راجع `generateCephExpertDiagnosis` وحالات القيم المفقودة وافتراض النمو والتوصيات القطعية. لا يُنشأ قلع/توسيع/TAD/جراحة أو بند خطة أو مهمة من اقتراح دون اختيار واعتماد الطبيب. تعذّر خدمة AI لا يبرر إخفاء التحول إلى محرك مختلف.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R203 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 10. عند الاستفادة من AI: أخبر المستخدم بمصدر الاقتراح، لا تحفظه كتشخيص معتمد تلقائيًا، وسجل موافقة الطبيب وتعديله. إرسال بيانات أو صور لخدمة خارجية يخضع لإعدادات المركز والصلاحيات وسياسة الاستخدام القائمة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R204 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 11. الدراسة المعتمدة تحفظ لقطة المعالم والمعايرة والقياسات والمرجع ونسخة المحرك واعتماد الطبيب. نسخة التصحيح تحتفظ بأصلها؛ صورة متابعة جديدة لا تُعامل كنسخة تصحيح للصورة السابقة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R205 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 12. المقارنة تختار صراحة الدراسات والإصدارات والتواريخ. اختلاف المرجع/الوحدة/طريقة القياس يظهر، ولا تُحسب مقارنة متجانسة زائفة. اعرض `بعد − قبل` بإشارته، وما لم يُقَس في الطرفين غير قابل للمقارنة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R206 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 13. راجع حد الضجيج الثابت الحالي في `cephCompare`؛ لا تعممه على جميع القياسات والوحدات كحقيقة سريرية غير موثقة. عبارة «اقترب من المرجع» لا تعني نجاح العلاج؛ تقييم النتيجة للطبيب.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R207 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 14. استعمل أداة الـSuperimposition الموجودة بعد التحقق من المعايرة وطريقة المطابقة والمعالم المشتركة. بيّن نوع المطابقة وحدودها؛ دوران/تحجيم صورة أو مطابقة S–N لا يساوي تلقائيًا كل أنواع superimposition السريرية. لا تولّد نتيجة عند غياب المدخلات اللازمة.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R208 — و. السيفالو — محطة د. عقلان الكامل

المطلب: 15. حافظ على عرض الدراسات القديمة التي لم تُربط بحالة، مع إجراء ربط صريح وصلاحية وتدقيق، لا اختفاء السجلات ولا نسبتها للحالة المفتوحة بالتخمين.

الملكية: lead Ceph safety
المسارات: lib/ceph.ts; CephTracer; cephCompare; cephSuperimpose; Ceph routes/store
القبول المطلوب: O03 O04 O10 O11 O12 O13
الحالة: in progress
التفصيل: Ceph safety V4 implemented awaiting independent review; historical review evidence, reference/version and comparison work remain open.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R218 — ز. تحليل الموديلات والمساحة

المطلب: 1. واجهة الفكين بمخطط الأسنان وترقيمها، وحقل العرض الأنسي الوحشي لكل سن مع الوحدة وحالة السن. التنقل بين الحقول بالكيبورد، ودعم الأرقام العربية والإنجليزية مع تحويل منضبط للفاصل العشري. لا تخلط الأرقام الصحيحة بالمليمتر والقيم النصية المستوردة.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R219 — ز. تحليل الموديلات والمساحة

المطلب: 2. لوحة قياسات للقوس العلوي والسفلي: المحيط/الطول المتاح، والقطاعات عند استخدام طريقة قطاعية، والعروض/الأعماق أو القياسات الإضافية التي يحتاجها التحليل المختار. كل حقل له اسم ومخطط إرشادي لنقاط القياس والوحدة، وليس خانة «حجم القوس» مبهمة لكل الطرق.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R220 — ز. تحليل الموديلات والمساحة

المطلب: 3. المدخلات مخزنة في مجموعة قياسات مؤرخة ذات مصدر واحد. عند إدخال القوس كإجمالي أو كمقاطع، حدد الطريقة المستخدمة؛ إذا أُدخلا معًا أظهر الفرق للتحقق ولا تجمعهما أو تختَر أحدهما بصمت.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R221 — ز. تحليل الموديلات والمساحة

المطلب: 4. قائمة «اختر التحليل» تعرض التحليلات المدعومة مع جاهزية كل واحد: جاهز للحساب / يحتاج قياسات محددة / لا ينطبق على نوع الأسنان / غير مفعّل لعدم اكتمال توثيقه. اسم غير منفذ لا يظهر كأنه تحليل جاهز.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R222 — ز. تحليل الموديلات والمساحة

المطلب: 5. اختيار التحليل يشغله تلقائيًا بمجرد اكتمال مدخلاته، ويُظهر النتيجة وجدول المدخلات والمعادلة الموثقة وإصدارها والوحدة والتفسير الحسابي. لا يطلب كتابة المجموع أو النسبة أو الفرق يدويًا إذا أمكن اشتقاقها من القياسات الأصلية.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R223 — ز. تحليل الموديلات والمساحة

المطلب: 6. أتح اختيار عدة تحليلات وتشغيل جميع الجاهز منها على نفس مجموعة القياسات. لا تعِد طلب قياس سُجل بالفعل للفك والسن والتاريخ والمصدر المناسبين.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R224 — ز. تحليل الموديلات والمساحة

المطلب: 7. أحجام الأسنان وطول القوس وحدهما لا يكفيان لجميع أنواع التحليل. إذا اختار الطبيب تحليلًا يحتاج عرضًا بين نقاط معينة أو قياسًا قاعديًا أو جدول تنبؤ أو معايرة/قياسًا شعاعيًا، اعرض **المدخلات الإضافية الناقصة فقط بالاسم وطريقة القياس**. لا تختلقها ولا تستبدلها بمتوسط غير ظاهر.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R225 — ز. تحليل الموديلات والمساحة

المطلب: 8. بعد تعديل قيمة، أعد حساب مسودات التحليلات المعتمدة عليها فقط وأظهر أنها تغيرت. التحليل المعتمد سابقًا يبقى ثابتًا؛ أنشئ مسودة إصدار جديد مع مقارنة الأثر بدل تغيير الماضي أو العرض المؤرشف.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R226 — ز. تحليل الموديلات والمساحة

المطلب: 9. تتغذى قائمة المشكلات وخطة المسافات وجدول العرض تلقائيًا من نتائج التحليل المختار بإصداره؛ الطبيب يراجع الاستنتاج السريري، ولا ينقل الأرقام يدويًا بين الشاشات.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R227 — ز. تحليل الموديلات والمساحة

المطلب: 10. حفظ النتيجة واعتمادها وتصديرها عمليات منفصلة. الحساب الآلي لا يعتمد التشخيص ولا يختار القلع أو التوسيع ولا ينشئ إجراءً علاجيًا من تلقاء نفسه.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R235 — ز. تحليل الموديلات والمساحة

المطلب: | قياسات أولية | الأسنان بترقيم FDI، العرض الأنسي الوحشي، الأسنان المفقودة/غير البازغة/غير المقاسة، أطوال ومقاطع الأقواس، العروض، الإطباق والجهة ومصدر القياس |

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R236 — ز. تحليل الموديلات والمساحة

المطلب: | الأسنان الدائمة | المساحة المتاحة والمطلوبة، فرق المسافة لكل فك، Bolton الأمامي والكلي، ونقص/زيادة الحجم السني مع بيان الفك المرجعي |

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R237 — ز. تحليل الموديلات والمساحة

المطلب: | العرض والقواعد العظمية | Ashley Howe، Pont، Linder Harth؛ تعريف نقاط القياس والمعاملات وقيود التفسير، بعد توثيقها |

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R238 — ز. تحليل الموديلات والمساحة

المطلب: | الأسنان المختلطة | Moyers بجداول موثقة وإصدار ومستوى احتمال، Tanaka–Johnston، Nance وHuckaba مع تصحيح التكبير ومرجع القياس |

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R239 — ز. تحليل الموديلات والمساحة

المطلب: | التحليلات المسماة دون تفصيل كافٍ في المراجع | Carey، Korkhaus، Peck–Peck وHixon–Oldfather وStanley–Kerber: سجل ما يحتاج مرجعًا أصليًا ومواصفة حسابية قبل التفعيل؛ لا تخترع معادلات لإكمال قائمة أسماء |

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R243 — ز. تحليل الموديلات والمساحة

المطلب: - لكل تحليل مواصفة: المدخلات المطلوبة، الأسنان الداخلة، الفك، المعادلة والإصدار، الوحدة، اتجاه الإشارة، سياسة التقريب، والقيم التي تمنع الحساب. يُراجع المرجع الأصلي قبل البرمجة، ولا تعتمد الشرائح وحدها لضمان صحة سريرية.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R244 — ز. تحليل الموديلات والمساحة

المطلب: - استخدم في عرض فرق المساحة تعريفًا معلنًا متسقًا؛ مثال المواصفة المطلوبة: المتاح ناقص المطلوب، السالب نقص مساحة والموجب فائض. لا يتبدل المعنى بين شاشة وأخرى.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R245 — ز. تحليل الموديلات والمساحة

المطلب: - قياسات الأسنان المخزنة تفصيلية؛ لا يُطلب من الطبيب إدخال المجموع يدويًا ثم الأسنان مرة ثانية. الإدخال اليدوي للمجموع القديم جائز لكن يُوسم بأنه إجمالي دون تفصيل.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R246 — ز. تحليل الموديلات والمساحة

المطلب: - لا تحسب Bolton الكامل إذا نقصت الأسنان المطلوبة دون أن يختار الطبيب تحليلًا بديلًا موثقًا. لا تعوّض السن المفقود تلقائيًا، ولا تستخدم صفرًا بدل القيمة المجهولة.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R247 — ز. تحليل الموديلات والمساحة

المطلب: - افصل نسبة Bolton عن مقدار الزيادة بالمليمتر، وبيّن أي فك اعتُمد مرجعًا. تُحسب القيم بدقة كافية ويقع التقريب عند العرض، لا في مراحل وسيطة كما في بعض أمثلة الشرائح.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R248 — ز. تحليل الموديلات والمساحة

المطلب: - جداول Moyers بيانات مرجعية بإصدار وتوثيق، لا صورة منخفضة الدقة يُخمَّن منها الرقم. إن لم يُتحقق الجدول، يمكن إدخال القيمة من الطبيب مع مصدرها ويظل الحساب الآلي غير مفعل.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R249 — ز. تحليل الموديلات والمساحة

المطلب: - تحليل الأسنان المختلطة يفرق بين القواطع المستخدمة للتنبؤ ومجموع الأسنان المطلوب للفك الجاري تقييمه؛ لا ينسخ مجموع الفك السفلي للفك العلوي تلقائيًا.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R250 — ز. تحليل الموديلات والمساحة

المطلب: - الشعاع غير المعاير/المشوه أو قياسه غير المعروف لا يعطي قياسًا سريريًا مؤكدًا. لا تُطلب صورة جديدة آليًا لمجرد أن التحليل يحتوي حقلًا شعاعيًا.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R251 — ز. تحليل الموديلات والمساحة

المطلب: - احفظ المدخلات والنتائج والمصدر ونسخة المعادلة مع اعتماد التحليل. عند تغيير قياس، أظهر أثره على التشخيص والخطة واطلب المراجعة بدل تعديل الخطة المعتمدة بصمت.

الملكية: assessment/model owner
المسارات: lib/ortho-assessment-model.ts; proposed schema2 result/ref registry
القبول المطلوب: O14 O15 O38 O39 O40
الحالة: in progress
التفصيل: basic_subset_only_advanced_disabled
المانع المحدد: Advanced method/reference identity, primary protocol and clinician approval are unresolved; basic supported draft arithmetic is only a partial foundation.
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R261 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - وصف الجهاز والبراكيت والشق لكل فك عند اختلافهما، تواريخ التركيب والتغيير، وطريقة العلاج: ثابت، متحرك، وظيفي، مصففات أو مزيج.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R262 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - مراحل الميكانيكا المخططة: alignment/leveling، أعمال المرحلة العاملة، إدارة المسافات، الإنهاء والتثبيت. المرحلة قابلة للتخصيص والعودة إليها مع السبب؛ لا يفرض البرنامج وصفة أسلاك واحدة.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R263 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - تسلسل أسلاك مخطط منفصل عن الأسلاك المركبة فعليًا. المقاس والمقطع والمادة والوحدة حقول منضبطة؛ الحروف الغامضة والمقاسات المستوردة القديمة تظهر للمراجعة دون تصحيح صامت.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R264 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - بناءً على C: خيارات IPR، expansion، distalization، uprighting، derotation، proclination، extraction، وأعمال space closure. يسجل الطبيب الاستطباب الذي اعتمده والبديل وسبب الاختيار؛ لا يحوله النظام تلقائيًا إلى أمر علاج.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R265 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - ميزانية مساحة لكل فك: النقص المقاس، المقترح الحصول عليه من كل إجراء، الاستخدام المخطط، والمسافة المقاسة لاحقًا. التقديرات تقريبية وليست قياسات، ولا تجمع فوائد متداخلة مرتين.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R266 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - IPR: كل تماس محدد بسنّين، المقدار المخطط، المنفذ في كل جلسة، المجموع التراكمي، والتاريخ والطبيب. لا تسجل المقدار مرة لكل سن ثم تضاعفه. تجاوز المخطط أو حد معتمد يُظهر مراجعة واضحة؛ لا تستورد حدًا عامًا من المحاضرة لكل الأسنان.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R267 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - التوسيع: الجهاز والفك وتاريخ التركيب وتعليمات الطبيب ونسخها وسجل ما أُبلغ/لوحظ والقياسات. لا تُولد معدلات تفعيل افتراضية من العمر أو من C15.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R268 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - القلع: الأسنان المطلوبة، الموافقة، الإحالة، وتاريخ التنفيذ المؤكد. «مخطط للقلع» يختلف عن «مخلوع» في المخطط السني.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R269 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - الإرساء/TADs: الموضع والتاريخ والإجراء والحالة والتغيير/الإزالة والمضاعفات؛ مصدر واحد مرتبط بالزيارة وخطة الحالة.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R270 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - المسافات والإغلاق: الفك والمقطع/الأسنان والمسافة المقاسة وطريقة الإغلاق والإرساء والتغير بين الزيارات، دون احتساب كل قياس تحسنًا تلقائيًا.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R271 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - إجراءات اللثة والترميم والجراحة والزراعة وغيرها تحال إلى خطة المريض المشتركة؛ لا ينشئ التقويم نسخًا من ملفات التخصصات الأخرى.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R272 — ح. الخطة والميكانيكا الحيوية والمسافات

المطلب: - اعتماد الخطة وموافقة المريض عمليتان متميزتان. تحفظ نسخة الخطة التي وافق عليها المريض وأي تغييرات لاحقة وموافقتها عند الحاجة.

الملكية: strategy/decision owner + lead execution contract
المسارات: lib/ortho-treatment-strategy*.ts; PatientPlans; proposed space/IPR event contract
القبول المطلوب: O06 O08 O16 O17 O28
الحالة: in progress
التفصيل: 0051_partial_new_execution_gaps
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R278 — ط. تسجيل الزيارة اليومية

المطلب: 1. التاريخ السريري، نوع الزيارة، الطبيب والمساعد، والشكوى/التغيّر منذ الزيارة السابقة.

الملكية: visit owner after322 / lead contract
المسارات: PatientOrtho; ortho_adjustments; clinical-visit/checkout existing routes
القبول المطلوب: O01 O05 O07 O08 O16 O28 O29
الحالة: in progress
التفصيل: existing_adjustments_partial
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R279 — ط. تسجيل الزيارة اليومية

المطلب: 2. الجهاز والأسلاك الحالية لكل فك مع إجراء صريح: احتُفظ به / غُيّر / أُزيل / غير معروف. الاستفادة من السابق اقتراح قابل للتأكيد وليست إثباتًا جديدًا تلقائيًا.

الملكية: visit owner after322 / lead contract
المسارات: PatientOrtho; ortho_adjustments; clinical-visit/checkout existing routes
القبول المطلوب: O01 O05 O07 O08 O16 O28 O29
الحالة: in progress
التفصيل: existing_adjustments_partial
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R280 — ط. تسجيل الزيارة اليومية

المطلب: 3. ما نُفذ فعليًا: الأسلاك والمطاطات ونقاطها وتعليماتها، power chain/springs/ligatures، الإصلاحات، IPR، TADs، أجهزة التوسيع، أو فحص مصففات وملاءمتها عند الحاجة.

الملكية: visit owner after322 / lead contract
المسارات: PatientOrtho; ortho_adjustments; clinical-visit/checkout existing routes
القبول المطلوب: O01 O05 O07 O08 O16 O28 O29
الحالة: in progress
التفصيل: existing_adjustments_partial
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R281 — ط. تسجيل الزيارة اليومية

المطلب: 4. القياسات المختارة، الصحة الفموية والتعاون والألم/الكسر أو المضاعفات، وتعليمات المريض. لا تُفرض حقول الأسلاك على زيارة مصففات أو مثبت.

الملكية: visit owner after322 / lead contract
المسارات: PatientOrtho; ortho_adjustments; clinical-visit/checkout existing routes
القبول المطلوب: O01 O05 O07 O08 O16 O28 O29
الحالة: in progress
التفصيل: existing_adjustments_partial
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R282 — ط. تسجيل الزيارة اليومية

المطلب: 5. الصور المرتبطة بهذه الزيارة بالمناظر والتواريخ الحقيقية، مع رفع آمن قابل لاستكمال الفشل دون تكرار الزيارة.

الملكية: visit owner after322 / lead contract
المسارات: PatientOrtho; ortho_adjustments; clinical-visit/checkout existing routes
القبول المطلوب: O01 O05 O07 O08 O16 O28 O29
الحالة: in progress
التفصيل: existing_adjustments_partial
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R283 — ط. تسجيل الزيارة اليومية

المطلب: 6. ما تغير في المشكلة أو الهدف، والخطوة التالية، والفترة/التاريخ المطلوب للمراجعة. الحجز الفعلي منفصل ويُربط بالنية الصحيحة للمتابعة.

الملكية: visit owner after322 / lead contract
المسارات: PatientOrtho; ortho_adjustments; clinical-visit/checkout existing routes
القبول المطلوب: O01 O05 O07 O08 O16 O28 O29
الحالة: in progress
التفصيل: existing_adjustments_partial
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R284 — ط. تسجيل الزيارة اليومية

المطلب: 7. حفظ مسودة ← مراجعة الطبيب وتوقيعه ← إتاحة ملخص التعليمات والحجز والتسليم للاستقبال.

الملكية: visit owner after322 / lead contract
المسارات: PatientOrtho; ortho_adjustments; clinical-visit/checkout existing routes
القبول المطلوب: O01 O05 O07 O08 O16 O28 O29
الحالة: in progress
التفصيل: existing_adjustments_partial
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R292 — ي. الإنهاء والتثبيت والمتابعة طويلة المدى

المطلب: - افصل انتهاء العلاج النشط عن إغلاق ملف الحالة بالكامل. تسليم المثبت لا يُخرج المريض تلقائيًا من متابعة التثبيت.

الملكية: 0053 retention owner + recall owner pending
المسارات: lib/ortho-case-journey*.ts; proposed0053 retention; lib/ortho-followup.ts
القبول المطلوب: O18 O19 O20
الحالة: in progress
التفصيل: 0053_draft_not_complete
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R293 — ي. الإنهاء والتثبيت والمتابعة طويلة المدى

المطلب: - فك الجهاز قد يكون في تاريخ مختلف لكل فك. سجل ما فُك وما بقي والسبب وخطة الاستكمال.

الملكية: 0053 retention owner + recall owner pending
المسارات: lib/ortho-case-journey*.ts; proposed0053 retention; lib/ortho-followup.ts
القبول المطلوب: O18 O19 O20
الحالة: in progress
التفصيل: 0053_draft_not_complete
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R294 — ي. الإنهاء والتثبيت والمتابعة طويلة المدى

المطلب: - لكل فك سجل أجهزة تثبيت متعدد: النوع، الأسنان/الامتداد، تاريخ التسليم الحقيقي، الحالة، تعليمات الطبيب، وملف المختبر المرتبط إن وجد. يدعم مثبتًا ثابتًا ومتحركًا للفك نفسه دون فقد أحدهما.

الملكية: 0053 retention owner + recall owner pending
المسارات: lib/ortho-case-journey*.ts; proposed0053 retention; lib/ortho-followup.ts
القبول المطلوب: O18 O19 O20
الحالة: in progress
التفصيل: 0053_draft_not_complete
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R295 — ي. الإنهاء والتثبيت والمتابعة طويلة المدى

المطلب: - بيانات قديمة ذات مثبت واحد تُنقل مع وسم «الفك غير محدد في السجل القديم» إذا كان مجهولًا؛ لا تخمن أنها للفكين.

الملكية: 0053 retention owner + recall owner pending
المسارات: lib/ortho-case-journey*.ts; proposed0053 retention; lib/ortho-followup.ts
القبول المطلوب: O18 O19 O20
الحالة: in progress
التفصيل: 0053_draft_not_complete
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R296 — ي. الإنهاء والتثبيت والمتابعة طويلة المدى

المطلب: - مراجعة التثبيت تسجل الملاءمة والكسر/الفقد والنظافة والالتزام والانتكاس والإصلاح/الاستبدال. لا تُعد مراجعة التثبيت «شدّة» لتحديث عداد المتابعة.

الملكية: 0053 retention owner + recall owner pending
المسارات: lib/ortho-case-journey*.ts; proposed0053 retention; lib/ortho-followup.ts
القبول المطلوب: O18 O19 O20
الحالة: in progress
التفصيل: 0053_draft_not_complete
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R297 — ي. الإنهاء والتثبيت والمتابعة طويلة المدى

المطلب: - يعين الطبيب استحقاق التثبيت؛ قوائم الاستقبال تستخدم هذا الاستحقاق وآخر مراجعة تثبيت. لا تُصنّف الحالة منقطعة ثمانية أسابيع لمجرد أن آخر شدّة كانت قبل شهور رغم انتظام مراجعات التثبيت.

الملكية: 0053 retention owner + recall owner pending
المسارات: lib/ortho-case-journey*.ts; proposed0053 retention; lib/ortho-followup.ts
القبول المطلوب: O18 O19 O20
الحالة: in progress
التفصيل: 0053_draft_not_complete
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R298 — ي. الإنهاء والتثبيت والمتابعة طويلة المدى

المطلب: - النتيجة النهائية تقارن الأهداف بالنتيجة الفعلية، وتعرض السجلات الختامية المتاحة والنواقص. عدم وجود صورة شعاعية ختامية لا يؤدي وحده إلى طلب تعرض جديد أو الادعاء بوجود الصورة.

الملكية: 0053 retention owner + recall owner pending
المسارات: lib/ortho-case-journey*.ts; proposed0053 retention; lib/ortho-followup.ts
القبول المطلوب: O18 O19 O20
الحالة: in progress
التفصيل: 0053_draft_not_complete
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R299 — ي. الإنهاء والتثبيت والمتابعة طويلة المدى

المطلب: - التوقف والتحويل والرفض والانتكاس وإعادة العلاج حالات صريحة بقرار الطبيب وتاريخ وسبب؛ يحتفظ كل منها بتاريخ ما سبق.

الملكية: 0053 retention owner + recall owner pending
المسارات: lib/ortho-case-journey*.ts; proposed0053 retention; lib/ortho-followup.ts
القبول المطلوب: O18 O19 O20
الحالة: in progress
التفصيل: 0053_draft_not_complete
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R303 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - حافظ على مسار `baseline/legacy` الموجود، وأضف ما يلزم لالتقاط ملخص العلاج السابق والجهاز والأسلاك والأعمال المكتملة والسجلات المتاحة.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R304 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - الأصل: أرشيف ورقي/نظام سابق/إفادة المريض/إفادة الطبيب. لكل معلومة حالة تحقق ومصدر؛ لا تُكتب بتاريخ تاريخي دقيق إذا لم يُعرف.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R305 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - إذا كانت الزيارات الماضية غير معروفة، أضف «ملخص علاج سابق» بدل اختراع زيارات شهرية أو أسماء أطباء أو صور T1.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R306 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - تاريخ أول زيارة في النظام لا يساوي تاريخ بدء التقويم. لا تُحسب مدة العلاج أو الانقطاع من افتراض مخفي.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R307 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - الاستيراد: معاينة، تعيين أعمدة، تحقق من الهوية والوحدات والعملات والتواريخ، كشف التكرار، تقرير رفض، ودفعة قابلة لإعادة التشغيل دون ازدواج. لا تنشئ نظام استيراد ثانٍ إذا كان الموجود قابلًا للامتداد.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R308 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - الملف التقويمي يعرض الاتفاق والخطة المالية الموجودة بصلاحية قراءة؛ الفواتير والدفعات والأرصدة تبقى في مصدرها المالي. لا ينشئ حفظ تقييم أو زيارة أو تصدير عرض فاتورة أو سند قبض.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R309 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - الأموال السابقة للنظام تُسجل عبر مسار الأرصدة/السداد التاريخي المعتمد الموجود، لا كإيراد يوم التحويل. يظل إثبات الدفع ومراجعته مستقلًا عن إثبات ما نُفذ سريريًا.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R310 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - لا تغيّر منطق YER/SAR/USD أو أسعار الصرف والتخصيصات. إذا كان الاتفاق بالسعودي والسداد باليمني، يُقرأ الناتج من المحرك المالي الأصلي، لا يعاد حسابه في قسم التقويم أو العرض.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R311 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - قرار «ضمن الباقة / يحتاج تسعيرًا / بلا رسوم بقرار / غير محسوم» لا يُختزل إلى السعر صفر. لا يُطلب ثمن لتوثيق حالة طبية قديمة مجهولة التسعير.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R319 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | أطراف الاتفاق | المريض والحالة والفرع، المسؤول المالي/ولي الأمر إن وجد، والطبيب المعالج؛ اسم الدافع لا يغير ملكية ملف المريض |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R320 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | نطاق العلاج | نسخة الخطة، الفك/الفكان، نوع الجهاز، مرحلة واحدة أو مراحل، تاريخ الاتفاق، وأي وصف مدة يحدده الطبيب مع بيان أنه تقدير وليس ضمانًا |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R321 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | الخدمات المشمولة | التركيب، الزيارات الدورية، السجلات/الصور أو التحليلات المحددة، فك الجهاز، المثبتات ومتابعتها عندما تكون مشمولة فعلًا؛ كل بند يحدد بدل الافتراض العام |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R322 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | غير المشمول والشروط المالية | الأعمال الإضافية، إصلاح/فقد أجهزة، استبدال مثبت، مختبر أو تصوير أو تدخل تخصص آخر حسب ما اتفق عليه؛ سبب المطالبة الإضافية ومرجعها واضحان |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R323 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | السعر | السعر قبل الخصم، الخصم ونوعه وسببه وصاحب صلاحية اعتماده، صافي الاتفاق، العملة YER/SAR/USD، وضرائب/رسوم فقط إن كانت مفعلة فعلًا في النظام وبإعدادات مناسبة |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R324 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | مصدر السعر | كتالوج/عرض معتمد/سعر مخصص بصلاحية؛ السعر النهائي يُتحقق منه على الخادم ولا يثق برقم الواجهة |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R325 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | بداية السداد | الدفعة الأولى المتفق عليها، استحقاقها، وما تم قبضه فعليًا بسند؛ الوعد بالدفع أو كتابة مبلغ الدفعة لا يساوي التحصيل |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R326 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | الأقساط | المبلغ والتاريخ لكل قسط، عددها، توزيع المتبقي، وخيار جدول ثابت أو دفعات مرتبطة بمراحل محددة وفق السياسة المعتمدة |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R327 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | الروابط | هوية الاتفاق وإصداره، الخطة وبنودها، الفاتورة/الفواتير المسموحة وفق النموذج الحالي، الدفعات وتخصيصاتها، وسجل الرصيد التاريخي إن وجد |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R328 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | الموافقة | حالة عرض/مسودة/موافق عليه/معدل/ملغى، نسخة قابلة للطباعة، من وافق وبأي صفة والتاريخ، والمرفق/التوقيع وفق آلية الموافقات الحالية |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R329 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | ملخص الحساب | صافي الاتفاق، المدفوع السابق الموثق، المقبوض الحالي، التسويات/الإشعارات الموثقة، المتبقي، المتأخر، والمطلوب الآن؛ كل مبلغ بعملته ومصدره |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R335 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 1. خطط وحالات التقويم الجديدة والقديمة تستخدم سياق علاج واتفاق موحدًا. «قبل النظام» وصف منشأ وتاريخ ومسار ترحيل، وليس قسم خطط منفصلًا ولا سببًا لإنشاء فاتورة وهمية.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R336 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 2. عند اعتماد الاتفاق، اربطه بمستند مالي صحيح عبر المسار المالي الحالي. إنشاء/اعتماد الفاتورة خطوة مالية صريحة حسب النظام؛ لا يصدرها حفظ السجل الطبي تلقائيًا. قبل التنفيذ وثّق مصدر المديونية الوحيد وكيف يُحسب المتبقي منه.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R337 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 3. الأقساط توزيع لاستحقاق المبلغ نفسه؛ لا تنشئ دينًا إضافيًا عند إضافة جدول الأقساط، ولا فاتورة جديدة بقيمة القسط فوق الفاتورة الأصلية. إعادة الجدولة لا تعيد قيمة العلاج إلى المديونية.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R338 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 4. لكل جلسة/عمل قرار تغطية صريح: ضمن الاتفاق المحدد / عمل إضافي مفوتر بموافقة / بلا رسوم بقرار موثق / يحتاج حسمًا ماليًا. الجلسة المشمولة لا تولد رسومًا جديدة كل مرة.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R339 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 5. الاستحقاق المرتبط بمرحلة يحتاج حدث تنفيذ موثوقًا وقاعدة تفعيل معتمدة؛ تغيير اسم المرحلة يدويًا أو الحجز أو طباعة العرض لا يُثبت أن الإجراء وقع ولا يُفعّل قبضًا.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R340 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 6. التحصيل الفعلي ينتج سندًا واحدًا بتخصيصات واضحة للفواتير/الأقساط، مع الصندوق/الوردية والطريقة والدافع والموظف والتاريخ. لا يُخصص المبلغ ذاته كاملًا لأكثر من بند.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R341 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 7. الدفع الجزئي يقلل الجزء المخصص فقط، والدفع مقدمًا يوزع وفق سياسة معلنة وقابلة للمراجعة. زيادة الدفع تتبع مسار رصيد/رفض/رد معتمد؛ لا تختفِ ولا يتحول المتبقي إلى رقم سالب غير مفسر.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R342 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 8. عند تعديل اتفاق أو إضافة خدمة، أنشئ إصدارًا وسببًا وموافقة وصاحب صلاحية، ثم تسوية مالية/مستندًا إضافيًا وفق المحرك القائم. لا تعدّل فاتورة معتمدة أو إيصالًا قديمًا بصمت ولا تحذف أثر الخصم.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R343 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 9. الإلغاء والتوقف والتحويل والإغلاق السريري لا يعني أن جميع المدفوعات تُرد أو المتبقي يسقط تلقائيًا. يستخدم المسؤول إجراء تسوية موثقًا حسب ما اتفق عليه؛ لا يخترع البرنامج معادلة استرداد قانونية أو نسبة تلقائية.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R344 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 10. فصل واضح بين رصيد التقويم ورصيد المريض العام؛ تظهر الصلة ببقية التخصصات دون تجميع أرصدة عملات مختلفة في رقم واحد أو تحميل التقويم دينًا لعمل آخر. المدفوع للأسرة/ولي الأمر يتبع تخصيصات النظام الحالية، ولا يُنقل بين المرضى تلقائيًا.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R345 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 11. لا تجعل تصدير Case Presentation أو اعتماد السيفالو سببًا لتغيير المديونية أو الأقساط أو عمولة الطبيب.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R349 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - عملة الاتفاق والفاتورة محفوظة لكل مستند. عملة التحصيل قد تختلف: يسجل مبلغ المقبوض وعملته، اتجاه سعر التحويل وقيمته وتاريخه ومن اعتمده، والمبلغ المكافئ المخصص بعملة الفاتورة.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R350 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - استعمل محرك التحويل والتقريب المالي القائم بعد التحقق منه. مثال اتجاه واضح: «1 SAR = 500 YER» في بيانات الاختبار؛ لا تعرض رقم 500 دون تعريف الزوج والاتجاه. هذا رقم اختبار اصطناعي وليس سعر صرف للسوق.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R351 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - يسجل الصندوق ما دخل فعليًا بعملة القبض، ويُخفض دين الفاتورة بما خصص بعملتها. لا تُعامل العمليتان كتحصيلين.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R352 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - كل سند يحتفظ بسعره التاريخي. تغيير سعر الإعدادات غدًا لا يعيد تقييم الأقساط المسددة أو يغير المتبقي التاريخي بأثر رجعي.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R353 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - تستخدم مبالغ عشرية/وحدات صغرى وسياسة تقريب موجودة ومعلنة حسب العملة. التقريب والتوزيع متعدد الفواتير لا ينتجان فرقًا مخفيًا؛ يعالج أي فرق عبر المسار المالي الموثق.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R354 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - يدعم دفعًا مجزأً بأكثر من عملة عبر سند/أسطر التحصيل التي يدعمها النظام، مع جمع التخصيصات بعد تحويلها بوضوح إلى عملة المستند، لا جمع SAR وYER وUSD مباشرة.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R355 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - عكس السداد يستخدم سجل الأصل وتخصيصاته وآلية العكس القائمة، لا سعر الصرف الحالي ولا تعديل إيصال الأصل. تحمى العملية بالصلاحية والتدقيق ومنع التكرار.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R359 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 1. شاشة مراجعة واحدة تعرض: إجمالي الاتفاق التاريخي، المدفوع قبل النظام، المتبقي بتاريخ الانتقال، مصدر كل مبلغ، العملة، والسجلات المالية الموجودة بالفعل. المبالغ غير المؤكدة تُوسم ولا تُعرض كقبض موثق.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R360 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 2. قبل الكتابة، طابق ما هو موجود: هل الرصيد الافتتاحي سُجل بالإجمالي أم بالمتبقي؟ وهل سُجلت مدفوعات سابقة بسندات؟ هل توجد فاتورة مرتبطة؟ أظهر فرق المطابقة وصافي الأثر المتوقع.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R361 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 3. لا تضف المتبقي التاريخي فوق فاتورة أو رصيد يحتسب المبلغ نفسه. التصميم المقبول يحافظ على مصدر مديونية واحد؛ إذا استُخدمت فاتورة لتمثيل الاتفاق التاريخي، يجب أن تعالج المدفوعات/التسويات التاريخية دون توليد قبض أو إيراد اليوم مرة أخرى ودون إبقاء الرصيد السابق مضافًا إليه.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R362 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 4. تعديل الخطأ التاريخي إجراء تصحيح موثق قابل للمراجعة: القيم قبل وبعد، المستندات المرجعية، السبب، صاحب الصلاحية، وأثره على كشف الحساب. لا تحذف إيصالات أو أرصدة قديمة لإخفاء الخطأ، ولا تعالج الخطأ بخصم عشوائي.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R363 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 5. تاريخ السداد الأصلي إن عُرف منفصل عن وقت تسجيله. لا يجعل ترحيل دفعات سابقة الصندوق الحالي أغنى، ولا يدخلها تقرير تحصيل اليوم كقبض جديد.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R364 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 6. بعد تثبيت الرصيد الصحيح، يُبنى جدول الأقساط على المتبقي المعتمد فقط. إعادة ربط الحالة بالخطة أو إعادة تشغيل الاستيراد لا تعيد تسجيل الرصيد أو القبض.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R365 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: 7. اسمح بتوثيق الزيارة والحالة الطبية أثناء مراجعة الماليات، مع إظهار «الرصيد قيد المراجعة» للأدوار المناسبة. لا تحول عدم اكتمال اتفاق قديم إلى رفض حفظ معلومات علاجية صحيحة.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R369 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **عند أول وصول:** يستدعي الاستقبال الملف/الموعد، ويحصّل رسوم الكشف إن كانت مطلوبة وفق إعدادات الخدمة. رسوم الكشف مستقلة عن اتفاق التقويم ما لم توجد قاعدة صريحة لاحتسابها ضمنه؛ لا يُعاد قبضها لمجرد فتح الحالة.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R370 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **عند عودة مريض التقويم:** تظهر مواعيده ومستحقه الحالي وعملته وحالة الأقساط. يمكن التحصيل أو تسجيل «الدفع بعد العلاج»/تأجيل مصرح بسبب ومسؤول حسب الصلاحية. لا تختزل كامل المتبقي إلى «المطلوب الآن».

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R371 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **على كرسي الطبيب:** يظهر العلاج المطلوب وتغطية الاتفاق حسب صلاحية الطبيب؛ لا يعيد إدخال حسابات الاستقبال. إضافة عمل خارج النطاق تنشئ قرارًا يحتاج التسعير/الموافقة، لا فاتورة مبهمة ولا صفرًا ضمنيًا.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R372 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **عند الخروج:** يظهر المطلوب الآن: ما استحق فعلًا مع الأعمال الإضافية المعتمدة، بعد احتساب ما قُبض في الزيارة، مع كشف مصدر المبلغ. إجراءات الخروج لا تُكرر السند عند إعادة المحاولة أو توقيع الزيارة مرة ثانية.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R373 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **المساعد:** يمكنه تجهيز الصور ومسودة الزيارة وفق صلاحياته، دون تعديل اتفاق أو خصم أو سعر صرف أو عكس قبض ما لم يمنحه المالك إذنًا محددًا.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R374 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **المختبر:** أمر جهاز/مثبت مرتبط بالحالة والفك والخطة، وتكلفة المختبر ومديونية المورد في حسابه بعملته. التكلفة ليست تلقائيًا سعر المريض؛ لا تُضاف مرتين لأن الجهاز ضمن الاتفاق وموجود أيضًا في طلب المختبر. الاستعانة بتكامل المختبر الحالي بدل إعادة بناء حسابه داخل التقويم.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R375 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **أعمال التخصصات الأخرى:** بند الخلع أو اللثة أو الترميم له طبيب منفذ وتغطية وتسعير محددان؛ لا يُنسب تلقائيًا لطبيب التقويم أو يُفوتر مرة ثانية من إحالة داخلية.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R376 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **العمولات:** استخدم محرك العمولة القائم وسياسة المركز. الطبيب المخطط والمنفذ قد يختلفان؛ لا تُحتسب عمولة جديدة لمجرد اعتماد الخطة أو إنشاء قسط أو عرض حالة.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R377 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **التقارير المطلوبة:** نسخة الاتفاق وإصداراته، جدول الأقساط، كشف حساب الحالة المرتبط بكشف المريض، إيصالات السداد، سجل التعديلات والتسويات، وقائمة الاستحقاقات والمتأخرات حسب العملة والفرع والصلاحية. لا تجمع عملات مختلفة في إجمالي غير معرف.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R378 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: - **الخصوصية:** اتفاق المريض وكشفه مستندان ماليان منفصلان عن عرض الحالة العلمي الافتراضي. لا يُدرج السعر والأقساط والاسم الكامل للمسؤول المالي في Case Presentation تعليمي تلقائيًا؛ يمكن إنشاء تقرير حالة إداري مقيّد بالصلاحية إذا طُلب.

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R386 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | اتفاق جديد | صافي 6,000 SAR؛ دفعة متفق عليها 1,000 SAR؛ عشر دفعات لاحقة كل منها 500 SAR | الجدول يساوي 6,000؛ كتابة الاتفاق لا تقبض شيئًا. بعد سند الدفعة الفعلي يصبح المتبقي 5,000 SAR؛ الأقساط لا تضيف مديونية ثانية |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R387 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | حالة قديمة | اتفاق تاريخي 6,000 SAR، سابق مدفوع موثق 2,500 SAR، متبقي 3,500 SAR | رصيد فعلي 3,500 مرة واحدة، لا 9,500 ولا 6,000؛ المدفوع السابق لا يدخل تحصيل اليوم |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R388 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | سداد بعملة أخرى | استحقاق 500 SAR؛ قبض 100,000 YER؛ سعر اختبار 1 SAR = 500 YER | تخصيص 200 SAR، يبقى من الاستحقاق 300 SAR؛ الصندوق يتلقى 100,000 YER مرة واحدة |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R389 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | جلسة مشمولة | شدّة ضمن اتفاق ساري مع قسط مستحق | توثيق الزيارة بلا رسوم شدّة جديدة؛ الاستقبال يرى القسط المستحق وفق الجدول |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R390 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | عمل إضافي | إصلاح غير مشمول، سعره وموافقته معتمدان | بند/مستند إضافي مرتبط وواضح؛ لا يغيّر ثمن كل الجلسات الماضية ولا يُكرر عند إعادة الطلب |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R391 — ك. الحالات القديمة والأرشيف والحسابات

المطلب: | تعديل صرف أو عكس قبض | تغيير سعر الإعدادات بعد السداد السابق ثم عكسه بصلاحية | السداد التاريخي لا يتغير؛ العكس يعالج أثر الأصل وتخصيصاته ولا يستخدم سعر اليوم اعتباطًا |

الملكية: financial context owner
المسارات: canonical plans/invoices/payments/installments/legacy/FX/checkout; new read-only context adapter
القبول المطلوب: O02 O27 O28 O41 O42 O43 O44 O45 O46 O47 O48 O49
الحالة: in progress
التفصيل: canonical_integration_in_progress_no_duplicate_engine
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R399 — ل. مولّد Case Presentation

المطلب: - افتح من ملف المريض صفحة «دراسة الحالة» باسم المريض الحالي واسم المركز وشعاره والطبيب المعالج. يظهر رقم الحالة وتواريخها وحالتها، ويمكن عرض المحتوى كدراسة مرتبة أو معاينة شرائح داخل البرنامج دون تنزيل ملف.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R400 — ل. مولّد Case Presentation

المطلب: - تُحفظ المقابلة والفحوص والقياسات والتحليلات والأشعة والتشخيص والخطة والموافقات والاتفاق والزيارات والنتائج في مصادرها المنظمة، وتُعرض مترابطة داخل ملف الحالة. لا تجعل ملف PowerPoint هو المستودع الوحيد للمعلومات.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R401 — ل. مولّد Case Presentation

المطلب: - العرض السريري الداخلي يُبنى من هذه المصادر؛ الاختيارات والعناوين والتعليقات الخاصة بالعرض تُحفظ مع الحالة. بعد إغلاق المتصفح والعودة أو استخدام جهاز آخر، تبقى البيانات والصور وتعديلات القص واختيارات العرض متاحة حسب الصلاحية.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R402 — ل. مولّد Case Presentation

المطلب: - دعم «مسودة دراسة» تتجدد من تعديلات السجل المسموحة، و«نسخة موثقة» بإصدارات مصادر ثابتة وتاريخ ومؤلف. تعديل المصدر بعد توثيق نسخة لا يغير تلك النسخة بصمت؛ يظهر توفر تحديث وتُنشأ نسخة جديدة عند اختيار الطبيب.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R403 — ل. مولّد Case Presentation

المطلب: - تصدير PPTX أو PDF عملية مستقلة من النسخة المختارة، يُسجل وقتها ومن أنشأها. فشل التصدير لا يحذف دراسة الحالة أو المسودة أو الصور أو التعديلات، ويمكن إعادة المحاولة دون إعادة التعبئة.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R404 — ل. مولّد Case Presentation

المطلب: - الاتفاق المالي موثق داخل ملف الحالة بصلاحياته، مع مستنداته المالية المستقلة؛ وجوده في البرنامج لا يعني إدراجه تلقائيًا في العرض السريري التعليمي. يختار المستخدم نطاق التقرير المناسب ضمن صلاحياته.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R405 — ل. مولّد Case Presentation

المطلب: - اسم المركز من الإعدادات واسم المريض من ملفه الفعلي؛ لا توجد بيانات الحالة المرجعية أو عنوانها في قالب الحالات الجديدة أو أسماء الأزرار أو ملفات الاختبار. يمكن ذكر الملف المرجعي باسمه داخل وثائق المطابقة الهندسية فقط.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R406 — ل. مولّد Case Presentation

المطلب: - عند إخفاء الهوية للتعليم، يحل رمز الحالة محل الاسم وفق الاختيار الصريح؛ النسخة السريرية الداخلية المعرّفة تعرض اسم المريض المقصود. هوية المركز والطبيب وحقوقه تبقى من إعدادات النسخة المناسبة.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R412 — ل. مولّد Case Presentation

المطلب: | A1–A2 | غلاف ومقابلة المريض بالترتيب نفسه | هوية المركز، الحالة، الشكوى والتاريخ |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R413 — ل. مولّد Case Presentation

المطلب: | A3 | لوحة الصور المركبة وبطاقة بيانات الحالة بتوزيعها المرجعي | صور المناظر المختارة؛ يدعم القالب الخانات الإضافية دون تغيير معنى المنظر |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R414 — ل. مولّد Case Presentation

المطلب: | A4–A8 | شرائح فحص الوجه والبروفايل والابتسامة والنسب | صور مختارة وتعليقات/قياسات الطبيب |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R415 — ل. مولّد Case Presentation

المطلب: | A9–A11 | شبكة الصور داخل الفم ثم النتائج السريرية | الصور الأمامية والجانبية والإطباقية والفحص |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R416 — ل. مولّد Case Presentation

المطلب: | A12–A14 | البانوراما، صورة السيفالو، جدول القياسات | الصور والدراسة المختارة بمرجعها، دون نسخ قيم المرجع |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R417 — ل. مولّد Case Presentation

المطلب: | A15–A18 | جدول الموديلات، Bolton، التشخيص والأهداف | التحليلات والتشخيص والأهداف المعتمدة |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R418 — ل. مولّد Case Presentation

المطلب: | A19–A20 | جدول Problem List / Treatment Plan / Strategies | روابط المشاكل والخطة والاستراتيجيات |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R419 — ل. مولّد Case Presentation

المطلب: | A21–A24 | شرائح الميكانيكا وخطة كل فك وتسلسلها | الخطة المعتمدة والتغييرات الموثقة |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R420 — ل. مولّد Case Presentation

المطلب: | A25 | تركيب الجهاز | حدث التركيب ومواصفات ما رُكب فعليًا |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R421 — ل. مولّد Case Presentation

المطلب: | A26–A40 | قالب الزيارة المتكرر: ثلاث صور علوية وصورتا إطباق بالأسفل، والنص والتاريخ والمرحلة في المساحة المخصصة | زيارة فعلية وصورها وأسلاكها وإجراءاتها؛ يتكرر بعدد الزيارات المختارة |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R422 — ل. مولّد Case Presentation

المطلب: | A41–A42 | قالب فك الجهاز والتثبيت بالصور ووصف كل فك | أحداث الإنهاء والتسليم الفعلية؛ لا زيارتان مفروضتان على كل مريض |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R423 — ل. مولّد Case Presentation

المطلب: | A43 | خاتمة اختيارية بهوية المركز | إعداد القالب |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R431 — ل. مولّد Case Presentation

المطلب: 1. رفع مجموعة صور من داخل الحالة/الزيارة، ثم شاشة تنظيم واحدة بخانات المناظر. يقترح البرنامج النوع/المنظر والموضع، ويعرض الاقتراح للمراجعة. يمكن السحب والإفلات أو التبديل أو اختيار الصورة المفضلة دون إعادة رفع.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R432 — ل. مولّد Case Presentation

المطلب: 2. لا تُنسب الصورة لمريض أو مرحلة أو تاريخ أو يمين/يسار اعتمادًا على تخمين غير مؤكد. السياق الصريح هو المريض والحالة والزيارة المفتوحة؛ التصنيف الذكي مساعد يمكن تصحيحه، وما لا يمكن تصنيفه يظهر في «بحاجة لتعيين».

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R433 — ل. مولّد Case Presentation

المطلب: 3. أداة مدمجة: تكبير وتحريك، قص حر أو بنسبة الخانة، تدوير وتصحيح ميل، وضبط سطوع/تباين محدود بمعاينة قبل/بعد، وتراجع/إعادة وتصفير التعديلات. لا يحتاج الطبيب فتح برنامج تحرير خارجي.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R434 — ل. مولّد Case Presentation

المطلب: 4. عند إدراج الصورة، احسب نسبة خانات قالب دراسة الحالة الخاص بالمركز، واقترح ملاءمة/قصًا مبدئيًا يحافظ على المنطقة المهمة، مع إطار معاينة. لا تمدد الصورة لتملأ الخانة ولا تقص الأسنان/الفك/الوجه المهم تلقائيًا. إذا تعذر القص الآمن، استخدم احتواء الصورة مع فراغ محايد واطلب مراجعة بدل تشويهها.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R435 — ل. مولّد Case Presentation

المطلب: 5. وفر وضع «ملء الخانة بالقص» و«إظهار الصورة كاملة»؛ تُحفظ النتيجة لكل استخدام. قد تُستخدم الصورة نفسها في لوحة السجلات وقالب الزيارة بقص مختلف دون رفع أصلين أو إفساد أحد العرضين.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R436 — ل. مولّد Case Presentation

المطلب: 6. البيانات المحفوظة: معرف الأصل وإصداره/بصمته، اتجاه EXIF المصحح، أبعاد الصورة، مستطيل القص بإحداثيات معرفة بوضوح، الدوران والتعديلات المسموحة، إصدار المحرر، مؤلف التعديل وتاريخه، والخانة/الاستخدام المقصود. تسلسل الدوران والقص والقياس محدد ويختبر رياضيًا.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R437 — ل. مولّد Case Presentation

المطلب: 7. احفظ الأصل غير المعدل؛ التعديلات وصفة تحويل ونسخة مشتقة قابلة لإعادة التوليد. حذف/تغيير القص لا يمحو الأصل. رفع نسخة جديدة لا يستبدل صورة سبق اعتماد تحليل عليها دون إصدار وربط صريح.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R438 — ل. مولّد Case Presentation

المطلب: 8. نفس وصفة التحويل تنتج المعاينة داخل البرنامج والصورة في PPTX وPDF؛ لا يختلف القص أو دوران الوجه عند التصدير. تُصنع المشتقات من الأصل بدقة مناسبة، لا من صورة المعاينة الصغيرة ولا بسلسلة ضغط متكرر.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R439 — ل. مولّد Case Presentation

المطلب: 9. أظهر تنبيهًا واضحًا عند انخفاض الدقة بالنسبة لحجم الخانة، ودع الطبيب يختار البديل. تحقق من الصور الكبيرة والمقلوبة وJPEG/PNG والصيغ الأخرى المدعومة بالفعل. أي HEIC أو صيغة غير مدعومة تُشرح طريقة تحويلها أو تُدعم بمحوّل مختبر، ولا يظهر نجاح رفع زائف.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R440 — ل. مولّد Case Presentation

المطلب: 10. لا تُجر تغييرات توليدية على الأسنان أو الابتسامة أو ملامح الوجه، ولا «تحسين تجميلي» يغير الدليل السريري. الانعكاس الأفقي/العمودي إن أتيح، يكون إجراء صريحًا مع وسم اتجاه، ولا يستخدم للتخمين في يمين/يسار المريض.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R441 — ل. مولّد Case Presentation

المطلب: 11. الصورة المستخدمة للقياس السيفالومتري لها نظام إحداثيات ومعايرة مستقلان عن نسخة العرض. قصّها لأجل الشريحة لا ينقل المعالم على الأصل ولا يعيد حساب القياسات. إذا طُلب تحليل الصورة المعدلة، يلزم مسار دراسة ومعايرة واضحان بدل استخدام معايرة الأصل خطأً.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R442 — ل. مولّد Case Presentation

المطلب: 12. معالجة الصور منضبطة النوع والحجم ومفاتيح التخزين والصلاحيات؛ لا تقبل مسارًا عامًا أو URL خارجيًا من العميل لمعالجة أي ملف. المساعد يعدّل ويجهز ما تسمح به صلاحياته، والطبيب يراجع الاختيارات اللازمة للعرض.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R443 — ل. مولّد Case Presentation

المطلب: 13. وفّر إعدادات محفوظة للقوالب مثل حدود ومسافات الصور وأحجام الخانات وطريقة الملاءمة. تطبيق القص الجماعي لا يعني نفس مستطيل القص لكل الصور؛ كل صورة تُراجع داخل إطارها.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R444 — ل. مولّد Case Presentation

المطلب: 14. راعِ وضع مشاركة العرض: الاقتصاص غير المتلف في السجل السريري لا يكفي لإخفاء هوية داخل PPTX. في نسخة المشاركة، ضمّن الصورة المشتقة المعالجة فعليًا، لا الأصل الكامل مع تعليمات قص يمكن التراجع عنها داخل PowerPoint.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R452 — ل. مولّد Case Presentation

المطلب: | 1 | غلاف المركز والطبيب ورمز/اسم الحالة حسب وضع الخصوصية | إعدادات الهوية وإعداد العرض |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R453 — ل. مولّد Case Presentation

المطلب: | 2 | المقابلة والشكوى والتاريخ الملائم وتقييم النمو | التقييم المرتبط بالمريض |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R454 — ل. مولّد Case Presentation

المطلب: | 3 | صور الوجه والفحص الخارجي والابتسامة | مجموعة تصوير مختارة وتقييمها |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R455 — ل. مولّد Case Presentation

المطلب: | 4 | الصور داخل الفم والعلاقات السنية | مجموعة وتصنيف وفحص بإصدار |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R456 — ل. مولّد Case Presentation

المطلب: | 5 | البانوراما والنتائج المسجلة | مستند مختار وتعليق الطبيب |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R457 — ل. مولّد Case Presentation

المطلب: | 6 | السيفالو والتتبع وجدول القياسات والتفسير | إصدار دراسة محدد، ومعايرته ومرجعه |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R458 — ل. مولّد Case Presentation

المطلب: | 7 | الموديلات وتحليل المسافة وBolton والتحليلات المختارة | قياسات وتحليل معتمد أو مسودة موسومة |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R459 — ل. مولّد Case Presentation

المطلب: | 8 | قائمة المشكلات والتشخيص والأهداف | نسخة التشخيص والخطة المختارة |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R460 — ل. مولّد Case Presentation

المطلب: | 9 | Problem / Treatment Plan / Strategies | روابط المشكلات والأهداف وخطة الميكانيكا |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R461 — ل. مولّد Case Presentation

المطلب: | 10 | خطة الأجهزة والإرساء والتسلسل المقصود لكل فك | نسخة الخطة، لا النتائج الفعلية |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R462 — ل. مولّد Case Presentation

المطلب: | 11 | التركيب ومسار الزيارات بالتاريخ والإجراء والصور | أحداث وجلسات مختارة من الخط الزمني |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R463 — ل. مولّد Case Presentation

المطلب: | 12 | التغييرات عن الخطة وأسبابها | سجل التعديلات المعتمد |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R464 — ل. مولّد Case Presentation

المطلب: | 13 | فك الجهاز والنتائج والمقارنات المتاحة | أحداث الإنهاء والسجلات المختارة |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R465 — ل. مولّد Case Presentation

المطلب: | 14 | المثبتات والتعليمات والمتابعة | سجل كل فك وزيارات التثبيت |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R466 — ل. مولّد Case Presentation

المطلب: | 15 | تقييم الأهداف والخلاصة المهنية والملاحظات | مراجعة الطبيب للنتائج |

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R470 — ل. مولّد Case Presentation

المطلب: 1. قوالب: عرض كامل مشابه للمرجع A، عرض تقدم مختصر، وعرض نهاية العلاج والتثبيت. لا تفرض 43 شريحة ولا 16 زيارة؛ العدد تابع للمحتوى.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R471 — ل. مولّد Case Presentation

المطلب: 2. القالب الافتراضي يأخذ نسبة أبعاد المرجع A وتوزيعه. اختر اللغة، ويمكن توفير نسب وثيمات إضافية كقوالب منفصلة. لا تغيّر نسبة شريحة المرجع ثم تمدد عناصره؛ طبّق ترتيب الصور المطلوب والحفاظ على نسبتها والقص الذي راجعه المستخدم.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R472 — ل. مولّد Case Presentation

المطلب: 3. واجهة معاينة تسمح باختيار/استبعاد جلسات وصور وتحليلات وإعادة ترتيب الأقسام. أظهر تاريخ كل صورة ودراسة ونسختها. لا تدخل بيانات حالة أخرى للمريض نفسه تلقائيًا.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R473 — ل. مولّد Case Presentation

المطلب: 4. النصوص والجداول والعناوين في PPTX قابلة للتحرير، والصور صور منفصلة عالية الجودة المناسبة. لا تحوّل الشريحة كلها إلى bitmap؛ ويمكن أن يكون التتبع/الرسم كصورة أو vector مع الاحتفاظ بالقياسات جدولًا قابلًا للتحرير.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R474 — ل. مولّد Case Presentation

المطلب: 5. الملف يُفتح في PowerPoint وLibreOffice، مع فحص RTL/LTR والأرقام والوحدات والخطوط وغياب انقطاع النصوص. أخرج PDF من نفس لقطة العرض، وتحقق بصريًا من صفحات طويلة وجداول كبيرة.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R475 — ل. مولّد Case Presentation

المطلب: 6. لا يُعاد إدخال بيانات المريض والقياسات والزيارات يدويًا في شاشة العرض. العناوين والتعليقات العرضية قابلة للتحرير، أما تعديل حقيقة سريرية فيرجع للمصدر بصلاحية مناسبة.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R476 — ل. مولّد Case Presentation

المطلب: 7. كل توليد يحفظ: هوية الحالة، اختيارات المصادر وإصداراتها، وقت القطع السريري، القالب وإصداره، نسخة المولّد، اللغة والخصوصية، المنشئ، حالة المهمة، وبصمة المحتوى/الملف. لا تخزن الاسم والبيانات الصحية في سجلات أخطاء عامة.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R477 — ل. مولّد Case Presentation

المطلب: 8. ثبّت لقطة المصادر في بداية التوليد بآلية متسقة. لو تغيّرت الحالة أثناء التوليد لا ينتج عرض نصفه من الإصدار القديم ونصفه من الجديد. إعادة الإنتاج تعني نفس محتوى اللقطة؛ البايتات المتطابقة تتطلب أيضًا ضبط metadata والتواريخ إن كانت ضمن معيار الاختبار.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R478 — ل. مولّد Case Presentation

المطلب: 9. المسودة تظهر عليها «مسودة» وما لم يُقَس/يُعتمد. العرض النهائي يستخدم المصادر المعتمدة وفق القالب أو يُظهر الاستثناء ومراجعته؛ لا يعتمد السيفالو أو التشخيص تلقائيًا لأنه صُدّر.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R479 — ل. مولّد Case Presentation

المطلب: 10. النواقص: لكل نقص وصف وزر يفتح مكان استكماله. يمكن استبعاد قسم غير متاح أو إظهاره بوصفه غير متاح. لا تملأ الفراغ بمثال من الملف المرجعي أو بقيمة صفر.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R480 — ل. مولّد Case Presentation

المطلب: 11. احتفظ بتاريخ التصدير وإصداراته. إعادة تصدير عرض قديم لا تستبدل محتواه بأحدث تشخيص دون طلب إصدار جديد.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R481 — ل. مولّد Case Presentation

المطلب: 12. معالجة التوليد على الخادم بمهمة لها تقدم وفشل واضح وإعادة محاولة آمنة. حدد حدود الصور والحجم والزمن والتوازي. استخدم تخزين الملفات الخاص القائم، ولا تعتمد على قرص Railway المؤقت كأرشيف دائم.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R482 — ل. مولّد Case Presentation

المطلب: 13. صلاحية التصدير مستقلة وتُفحص عند طلب المهمة وأثناء جلب أصولها وعند تنزيل الملف. سحب الصلاحية قبل التنزيل يُحترم؛ التخزين المؤقت لا يخلط المستخدمين أو الحالات. لا تُقبل URL خارجية عشوائية لجلب الصور من الخادم.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R483 — ل. مولّد Case Presentation

المطلب: 14. النسخة السريرية المعرّفة تختلف عن نسخة التعليم/المشاركة. إزالة الاسم وحدها لا تعني إخفاء الهوية لأن الوجه والصورة الشعاعية قد يحملان تعريفًا. وفّر معاينة لما سيخرج، وموافقة المشاركة اللازمة، وخيار استبعاد/معالجة الصور المعرِّفة فعليًا.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R484 — ل. مولّد Case Presentation

المطلب: 15. افحص مكونات PPTX الداخلية: الصور الأصلية المخفية تحت قصّ، EXIF، أسماء الملفات، خصائص المؤلف، notes، التعليقات، الصور المصغرة والنص المضمن. إزالة عنصر مرئي أو تغطية الوجه في الشريحة لا تزيله من ملف PPTX المضغوط. أنشئ نسخة صورة معالجة بالفعل لوضع المشاركة مع حفظ الأصل السريري منفصلًا.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R485 — ل. مولّد Case Presentation

المطلب: 16. التصدير والتنزيل لا يرسلان العرض تلقائيًا بالبريد أو واتساب ولا ينشرانه. مشاركة الملف إجراء مستقل بصلاحية وسجل.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R486 — ل. مولّد Case Presentation

المطلب: 17. لا يلزم استيراد PPTX قديم لبناء الملف السريري. إذا أرفق الطبيب عرضًا قديمًا، يحفظ كمستند مرجعي؛ استخلاص بياناته وتحويلها لسجل يتطلب مراجعة صريحة ولا يكتب فوق بيانات الحالة.

الملكية: renderer +0053 +media owners / lead contract
المسارات: persisted study workspace/revisions; reviewed per-use transforms; explicit export manifest/job; actualPPTX/PDF
القبول المطلوب: O21 O22 O23 O24 O25 O26 O31 O32 O33 O34 O35 O36 O37 O49 O50 O51 O52
الحالة: in progress
التفصيل: new_in_app_study_scope_and_export_boundary_unfrozen
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R490 — م. الصلاحيات والإعدادات

المطلب: - الطبيب: فحص وتشخيص وخطة واعتماد وتصحيح ومراجعة نتائج؛ وفق صلاحيات المؤسسة الفعلية.

الملكية: domain authority owners + root
المسارات: session/patient-access/permissions/settings; domain route guards
القبول المطلوب: O04 O06 O17 O26 O29
الحالة: in progress
التفصيل: requires_current_guard_review
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R491 — م. الصلاحيات والإعدادات

المطلب: - المساعد: تجهيز صور وسجلات ومسودات الزيارة ومهام مسموحة؛ لا يعتمد تشخيصًا أو خطة لمجرد قدرته على الرفع.

الملكية: domain authority owners + root
المسارات: session/patient-access/permissions/settings; domain route guards
القبول المطلوب: O04 O06 O17 O26 O29
الحالة: in progress
التفصيل: requires_current_guard_review
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R492 — م. الصلاحيات والإعدادات

المطلب: - الاستقبال: الحجز والمتابعة والتعليمات المصرح بها، وحالة الاستحقاق والخروج. عرض تفاصيل سريرية أو صور يعتمد على الإذن ولا يُفترض ضمنيًا.

الملكية: domain authority owners + root
المسارات: session/patient-access/permissions/settings; domain route guards
القبول المطلوب: O04 O06 O17 O26 O29
الحالة: in progress
التفصيل: requires_current_guard_review
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R493 — م. الصلاحيات والإعدادات

المطلب: - المدير/مالك المركز: إعدادات وصلاحيات وتقارير؛ صلاحية الإدارة التشغيلية لا تتحول تلقائيًا إلى اعتماد سريري إلا وفق الدور المصرح به.

الملكية: domain authority owners + root
المسارات: session/patient-access/permissions/settings; domain route guards
القبول المطلوب: O04 O06 O17 O26 O29
الحالة: in progress
التفصيل: requires_current_guard_review
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R494 — م. الصلاحيات والإعدادات

المطلب: - إعدادات قابلة للإدارة: هوية المركز، قوالب الصور والعروض، نصوص القوالب بالعربية والإنجليزية، قوائم الأجهزة والمثبتات والأسلاك، تصنيفات الزيارات، فترات المتابعة التي يختارها الطبيب، مستوى إظهار التحليلات، وصلاحيات التصدير والمشاركة.

الملكية: domain authority owners + root
المسارات: session/patient-access/permissions/settings; domain route guards
القبول المطلوب: O04 O06 O17 O26 O29
الحالة: in progress
التفصيل: requires_current_guard_review
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R495 — م. الصلاحيات والإعدادات

المطلب: - تعديل مرجع سريري أو صيغة حسابية يختلف عن تعديل لون أو شعار؛ له إصدار وتحقق واعتماد، لا خانة نص حر تنفذ كودًا أو SQL. لا يُحذف خيار سبق استعماله؛ يعطل للاستخدام الجديد وتبقى تسميته التاريخية.

الملكية: domain authority owners + root
المسارات: session/patient-access/permissions/settings; domain route guards
القبول المطلوب: O04 O06 O17 O26 O29
الحالة: in progress
التفصيل: requires_current_guard_review
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R499 — ن. الاستضافة وStaging

المطلب: 1. استخدم بيئة Railway الاختبارية الموجودة بعد التحقق من هويتها وخدماتها وحالة نشرها. وجود المتغيرات لا يثبت أن النسخة تعمل.

الملكية: root/publisher only
المسارات: Railway staging; Dockerfile; CI; job/storage/backup infrastructure
القبول المطلوب: O26 O29 O30
الحالة: not started
التفصيل: not_executed_in_this_packet
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R500 — ن. الاستضافة وStaging

المطلب: 2. قاعدة اختبار ومخزن ملفات وأسرار مستقلة عن الإنتاج، مع بيانات اصطناعية أو منزوعة التعريف بصورة صحيحة. لا ترفع بيانات المرضى أو ملفات المرجع الخاصة إلى مستودع أو نتائج CI.

الملكية: root/publisher only
المسارات: Railway staging; Dockerfile; CI; job/storage/backup infrastructure
القبول المطلوب: O26 O29 O30
الحالة: not started
التفصيل: not_executed_in_this_packet
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R501 — ن. الاستضافة وStaging

المطلب: 3. امنع الإرسال الحقيقي في Staging افتراضيًا للبريد وSMS وواتساب، واستخدم مستقبلات اختبار محددة؛ لا تصل تذكيرات التجارب إلى مرضى حقيقيين.

الملكية: root/publisher only
المسارات: Railway staging; Dockerfile; CI; job/storage/backup infrastructure
القبول المطلوب: O26 O29 O30
الحالة: not started
التفصيل: not_executed_in_this_packet
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R502 — ن. الاستضافة وStaging

المطلب: 4. شغّل ترحيلات PostgreSQL الحقيقية على نسخة اختبار لها مخطط ممثل، واختبر الاستيراد والعودة الآمنة واستعادة النسخة الاحتياطية. نجاح PGlite وحده لا يكفي لتغييرات القيود والتزامن.

الملكية: root/publisher only
المسارات: Railway staging; Dockerfile; CI; job/storage/backup infrastructure
القبول المطلوب: O26 O29 O30
الحالة: not started
التفصيل: not_executed_in_this_packet
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R503 — ن. الاستضافة وStaging

المطلب: 5. تشغيل مولّد العروض داخل خدمات Railway الملائمة: خدمة/عامل خلفي عند الحاجة، خط عربي متاح، أدوات التحويل المثبتة، حدود للذاكرة والوقت، وتنظيف الملفات المؤقتة بعد النجاح أو الفشل. اختر حزمة توليد بعد مراجعة توافقها وترخيصها والحاجة الفعلية؛ لا تفترض أنها مثبتة الآن.

الملكية: root/publisher only
المسارات: Railway staging; Dockerfile; CI; job/storage/backup infrastructure
القبول المطلوب: O26 O29 O30
الحالة: not started
التفصيل: not_executed_in_this_packet
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R504 — ن. الاستضافة وStaging

المطلب: 6. أضف اختبارات صحة ومراقبة فشل المهام وسجل تدقيق دون بيانات صحية في logs. مستندات وصور التصدير خاصة، وليست أصولًا عامة للواجهة.

الملكية: root/publisher only
المسارات: Railway staging; Dockerfile; CI; job/storage/backup infrastructure
القبول المطلوب: O26 O29 O30
الحالة: not started
التفصيل: not_executed_in_this_packet
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R505 — ن. الاستضافة وStaging

المطلب: 7. اختبر rollback على مستوى التطبيق وسياسة توافق المخطط. لا تسقط أعمدة أو بيانات قديمة في الإصدار الأول؛ وثّق الاسترجاع دون فقد السجلات المنشأة بعد النشر.

الملكية: root/publisher only
المسارات: Railway staging; Dockerfile; CI; job/storage/backup infrastructure
القبول المطلوب: O26 O29 O30
الحالة: not started
التفصيل: not_executed_in_this_packet
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R513 — س. تقسيم العمل وتسليمه

المطلب: | 0 — تثبيت الحقيقة | جرد main والفروع، خريطة ملكية البيانات، مخطط العلاقات، مصدر كل حقل، مصفوفة المراجع والشاشات | تقرير فجوات حديث وقرارات معمارية قصيرة، واختبارات حماية الأساس |

الملكية: lead/root sequencing
المسارات: docs/ORTHO_CEPH_IMPLEMENTATION_PLAN_AR.md; bounded domain packets
القبول المطلوب: all O01-O52
الحالة: in progress
التفصيل: implementation_sequencing_active
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R514 — س. تقسيم العمل وتسليمه

المطلب: | 1 — سلامة السيفالو والسياق | معالجة/تنسيق #319 و#320 و#322، نقص البيانات ومصدر الاقتراح، هوية الدراسة والتصحيح، عزل المريض | اختبارات تزامن وصلاحيات ومسودات ودراسات قديمة ناجحة |

الملكية: lead/root sequencing
المسارات: docs/ORTHO_CEPH_IMPLEMENTATION_PLAN_AR.md; bounded domain packets
القبول المطلوب: all O01-O52
الحالة: in progress
التفصيل: implementation_sequencing_active
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R515 — س. تقسيم العمل وتسليمه

المطلب: | 2 — التقييم والسجلات والموديلات | التقييم المنظم، مجموعات الصور، تحليلات أساسية موثقة، تاريخ واعتماد القياسات | رحلة حالة جديدة وقديمة بلا ازدواج مع نتائج حساب يمكن التحقق منها |

الملكية: lead/root sequencing
المسارات: docs/ORTHO_CEPH_IMPLEMENTATION_PLAN_AR.md; bounded domain packets
القبول المطلوب: all O01-O52
الحالة: in progress
التفصيل: implementation_sequencing_active
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R516 — س. تقسيم العمل وتسليمه

المطلب: | 3 — الخطة والتنفيذ والاتفاق | مشكلة/هدف/استراتيجية، مسافات وIPR وإحالات، اتفاق وفاتورة وأقساط وتخصيصات، زيارة مختصرة ورحلة الاستقبال والخروج | خطة واتفاق بإصدارات، تنفيذ وتحصيل لا يتكرران، وحالات العملات والأرصدة القديمة متحققة |

الملكية: lead/root sequencing
المسارات: docs/ORTHO_CEPH_IMPLEMENTATION_PLAN_AR.md; bounded domain packets
القبول المطلوب: all O01-O52
الحالة: in progress
التفصيل: implementation_sequencing_active
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R517 — س. تقسيم العمل وتسليمه

المطلب: | 4 — التثبيت | فك الجهاز والمثبتات لكل فك والاستحقاقات والانتكاس | حالة علوي متحرك وسفلي ثابت، ومراجعات منتظمة دون إنذارات انقطاع كاذبة |

الملكية: lead/root sequencing
المسارات: docs/ORTHO_CEPH_IMPLEMENTATION_PLAN_AR.md; bounded domain packets
القبول المطلوب: all O01-O52
الحالة: in progress
التفصيل: implementation_sequencing_active
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R518 — س. تقسيم العمل وتسليمه

المطلب: | 5 — عرض الحالة | كامل/تقدم/ختامي، PPTX وPDF، الخصوصية واللقطات والمهام | ملف فعلي قابل للتحرير ومراجع بصريًا، مأخوذ من نفس البيانات دون إعادة إدخال |

الملكية: lead/root sequencing
المسارات: docs/ORTHO_CEPH_IMPLEMENTATION_PLAN_AR.md; bounded domain packets
القبول المطلوب: all O01-O52
الحالة: in progress
التفصيل: implementation_sequencing_active
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R519 — س. تقسيم العمل وتسليمه

المطلب: | 6 — الاستكمال والتشغيل | التحليلات المتقدمة الموثقة، الاستيراد، جودة العربية والإنجليزية، الأداء والتشغيل والاستعادة | إغلاق مصفوفة المتطلبات أو تصريح صريح بما تعذر، وأدلة قبول على Staging |

الملكية: lead/root sequencing
المسارات: docs/ORTHO_CEPH_IMPLEMENTATION_PLAN_AR.md; bounded domain packets
القبول المطلوب: all O01-O52
الحالة: in progress
التفصيل: implementation_sequencing_active
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R531 — ع. اختبارات القبول الإلزامية

المطلب: | O01 | مريض جديد ← تقييم ← صور ← خطة ← زيارة | حالة وسياق واحد، دون تكرار الهوية أو التشخيص أو الزيارة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R532 — ع. اختبارات القبول الإلزامية

المطلب: | O02 | مريض بدأ التقويم قبل النظام ولا تتوفر سجلات أولية | إدخال ملخص سابق بتواريخه المعلومة دون اختراع T1 أو زيارات |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R533 — ع. اختبارات القبول الإلزامية

المطلب: | O03 | حالتان للمريض نفسه/صورة غير مرتبطة | لا اختلاط في السجلات أو السيفالو أو التصدير؛ ربط صريح فقط |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R534 — ع. اختبارات القبول الإلزامية

المطلب: | O04 | تبديل مريض/حالة أو سحب إذن أثناء الطلب | لا ظهور بيانات في السياق الآخر ولا قبول كتابة غير مصرح بها |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R535 — ع. اختبارات القبول الإلزامية

المطلب: | O05 | فقد رد الحفظ ثم إعادة المحاولة | لا تتكرر الزيارة أو IPR أو دفعة الاستيراد؛ تظهر النتيجة غير المؤكدة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R536 — ع. اختبارات القبول الإلزامية

المطلب: | O06 | طبيبان يعدلان الخطة أو الدراسة | كشف تعارض أو تسلسل آمن، دون ضياع صامت للتعديلات |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R537 — ع. اختبارات القبول الإلزامية

المطلب: | O07 | إدخال زيارة قديمة بين زيارات قائمة | الترتيب صحيح، والمعرفات والصور والتواقيع لا تتغير |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R538 — ع. اختبارات القبول الإلزامية

المطلب: | O08 | الاحتفاظ بالسلك ثم تغييره/إزالته | التاريخ الفعلي دقيق، والمخطط لا يظهر كأنه مركب |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R539 — ع. اختبارات القبول الإلزامية

المطلب: | O09 | صور متعددة للمنظر في تواريخ مختلفة | اختيار المجموعة واضح؛ لا تُعرض كمجموعة زمنية واحدة مصطنعة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R540 — ع. اختبارات القبول الإلزامية

المطلب: | O10 | صورة بلا معايرة أو نقطة لازمة | لا أطوال مؤكدة ولا صفر بديل ولا اعتماد نتيجة ناقصة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R541 — ع. اختبارات القبول الإلزامية

المطلب: | O11 | تصحيح دراسة معتمدة ثم مقارنة متابعة | المعتمد الأصلي ثابت، أصل التصحيح معروف، ومتابعة الصورة الجديدة منفصلة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R542 — ع. اختبارات القبول الإلزامية

المطلب: | O12 | مرجعان/وحدتان/نسختا محرك مختلفتان | تحذير/منع حسب المواصفة، دون فرق رقمي مضلل |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R543 — ع. اختبارات القبول الإلزامية

المطلب: | O13 | عمر مجهول وفشل AI وقياسات ناقصة | لا افتراض نمو أو نتائج طبيعية أو توصية معتمدة تلقائيًا |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R544 — ع. اختبارات القبول الإلزامية

المطلب: | O14 | Bolton ومجموع الأسنان وفرق المساحة | نتائج مقابل أمثلة مستقلة موثقة، مع اختبارات التقريب والأسنان المفقودة والقيم الحدية |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R545 — ع. اختبارات القبول الإلزامية

المطلب: | O15 | تحليل مختلط للفكين ومقياس شعاعي | لا خلط لمجاميع الفكين؛ جداول/معادلات وإصدارات ومعايرة صحيحة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R546 — ع. اختبارات القبول الإلزامية

المطلب: | O16 | IPR لنفس التماس في زيارتين وإعادة إرسال الطلب | المجموع صحيح بلا تضاعف، ومخطط/منفذ متمايزان |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R547 — ع. اختبارات القبول الإلزامية

المطلب: | O17 | تعديل خطة موقعة ورفض المريض بديلًا | إصدار وتدقيق وموافقة مرتبطة بالنسخة المناسبة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R548 — ع. اختبارات القبول الإلزامية

المطلب: | O18 | مثبتان مختلفان للفكين وتسليم بتاريخ قديم | حفظ مستقل وتاريخ فعلي، لا كتابة اليوم أو استبدال أحدهما بالآخر |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R549 — ع. اختبارات القبول الإلزامية

المطلب: | O19 | مثبت ثابت ومتحرك للفك نفسه ثم استبدال | تاريخ أجهزة كامل، والمراجعة مرتبطة بالجهاز الصحيح |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R550 — ع. اختبارات القبول الإلزامية

المطلب: | O20 | تثبيت منتظم وآخر شدّة قديمة | قائمة المتابعة تعتمد استحقاق التثبيت، بلا إنذار انقطاع آلي من عداد الشدّات |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R551 — ع. اختبارات القبول الإلزامية

المطلب: | O21 | حالة مرجعية اصطناعية طويلة بزيارات كثيرة | PPTX وPDF يطابقان ترتيب A ومصادر الحالة، دون 43 شريحة مفروضة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R552 — ع. اختبارات القبول الإلزامية

المطلب: | O22 | استكمال بيانات أثناء توليد عرض | نسخة متسقة من لقطة محددة، لا محتوى هجين |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R553 — ع. اختبارات القبول الإلزامية

المطلب: | O23 | PPTX عربي وإنجليزي مع جدول طويل وصور | نص وجداول قابلة للتحرير؛ لا قص أو تداخل؛ فتح فعلي في عارضين |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R554 — ع. اختبارات القبول الإلزامية

المطلب: | O24 | عرض مسودة/نهائي به بيانات غير معتمدة | توضيح الحالة وعدم تمرير مسودة على أنها نتيجة معتمدة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R555 — ع. اختبارات القبول الإلزامية

المطلب: | O25 | تصدير تعليمي مع صور وmetadata | فحص محتويات ZIP والملفات المضمنة وعدم تسرب هوية مخفية تحت القص أو في notes |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R556 — ع. اختبارات القبول الإلزامية

المطلب: | O26 | سحب إذن الصور/التصدير بعد بدء المهمة | التوليد/التنزيل يحترمان الصلاحية الحالية دون تسرب الملفات |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R557 — ع. اختبارات القبول الإلزامية

المطلب: | O27 | استيراد ملف قديم مرتين مع بعض الصفوف الخاطئة | لا تكرار، تقرير رفض وتطابق واضح، واستكمال آمن للدفعة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R558 — ع. اختبارات القبول الإلزامية

المطلب: | O28 | حفظ زيارة وتصدير واستيراد مع اتفاق SAR وسداد YER | لا تغيير في الفواتير والسندات أو إعادة حساب مالي من قسم التقويم |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R559 — ع. اختبارات القبول الإلزامية

المطلب: | O29 | Staging بها قالب رسالة وتذكير | لا رسالة إلى مريض حقيقي؛ أثر الاختبار ظاهر بمستقبل اختبار |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R560 — ع. اختبارات القبول الإلزامية

المطلب: | O30 | ترحيل على PostgreSQL ثم نشر/رجوع/استعادة | سلامة البيانات والقيود والتواريخ والروابط، مع دليل استعادة فعلي |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R561 — ع. اختبارات القبول الإلزامية

المطلب: | O31 | تعبئة حالة اصطناعية ثم اختيار قالب دراسة الحالة الخاص بالمركز | الشرائح الأساسية وتوزيع الصور والجداول مماثلة للمرجع وفق جدول المطابقة، دون ترتيب خارجي يدوي |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R562 — ع. اختبارات القبول الإلزامية

المطلب: | O32 | رفع دفعة صور وتصحيح اقتراح تصنيفها | تعيين صحيح للمناظر والحالة والزيارة، وتعديل سهل دون فقد المصدر |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R563 — ع. اختبارات القبول الإلزامية

المطلب: | O33 | قص وتدوير صورة ذات اتجاه EXIF ثم إعادة فتحها | إعادة إنتاج دقيقة للتحويل، وأصل محفوظ وقابل للرجوع |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R564 — ع. اختبارات القبول الإلزامية

المطلب: | O34 | صورة واحدة بقصين مختلفين في لوحتين | استخدامان مستقلان من الأصل نفسه؛ تغيير أحدهما لا يفسد الآخر |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R565 — ع. اختبارات القبول الإلزامية

المطلب: | O35 | معاينة ثم PPTX ثم PDF لصورة مقصوصة | تطابق القص والحجم النسبي والاتجاه دون تمدد أو دقة رديئة غير مبينة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R566 — ع. اختبارات القبول الإلزامية

المطلب: | O36 | قص صورة مستخدمة في سيفالو معتمد لأجل العرض | لا تتغير المعالم أو المعايرة أو القياسات المعتمدة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R567 — ع. اختبارات القبول الإلزامية

المطلب: | O37 | صورة لا يمكن قصها بأمان لخانة القالب | اختيار الاحتواء أو المراجعة؛ لا حذف منطقة سريرية مهمة بصمت |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R568 — ع. اختبارات القبول الإلزامية

المطلب: | O38 | وصول مريض جديد ثم إكمال رحلة التقييم خطوة بخطوة | نفس هوية المريض والحالة تتبع المقابلة والفحص خارج/داخل الفم والقياسات والبانوراما والسيفالو والخطة؛ استئناف آمن بعد الانقطاع |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R569 — ع. اختبارات القبول الإلزامية

المطلب: | O39 | إدخال قياسات الأسنان والقوس مرة واحدة واختيار عدة تحليلات | تشغيل التحليلات الجاهزة آليًا دون إدخال مجاميع/نتائج يدويًا؛ ما يحتاج مدخلات إضافية يطلبها تحديدًا ولا يخمنها |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R570 — ع. اختبارات القبول الإلزامية

المطلب: | O40 | تعديل قياس بعد اعتماد تحليل وتصدير عرض | إعادة حساب المسودات المرتبطة مع حفظ النسخة المعتمدة والعرض السابق؛ النسخة الجديدة تستخدم نتيجة جديدة ذات مصدر معروف |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R571 — ع. اختبارات القبول الإلزامية

المطلب: | O41 | اعتماد اتفاق وجدولة أقساطه | جدول يطابق صافي الاتفاق دون إنشاء دين إضافي؛ الدفعة المخططة لا تُسجل قبضًا |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R572 — ع. اختبارات القبول الإلزامية

المطلب: | O42 | اتفاق قديم له رصيد/سندات سابقة ثم إعادة ربطه | مصدر مديونية واحد وتقرير مطابقة؛ لا ازدواج في المبلغ ولا قبض تاريخي داخل صندوق اليوم |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R573 — ع. اختبارات القبول الإلزامية

المطلب: | O43 | اتفاق SAR وسداد YER أو USD وتغيير سعر الإعدادات | مبلغ صندوق فعلي وتخصيص بعملة الفاتورة وسعر تاريخي ثابت مع اتجاه ووحدة واضحين |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R574 — ع. اختبارات القبول الإلزامية

المطلب: | O44 | تحصيل جزئي/مقدم/متعدد العملات ثم إعادة المحاولة | تخصيصات صحيحة، سند واحد، فرق تقريب معلن، وعدم تجاوز السياسة المالية للزيادة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R575 — ع. اختبارات القبول الإلزامية

المطلب: | O45 | شدّة مشمولة وعمل إضافي في الزيارة نفسها | المشمولة لا تُفوتر ثانية؛ الإضافي يحتاج قرار سعر/موافقة ومصدر مطالبة واضحًا |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R576 — ع. اختبارات القبول الإلزامية

المطلب: | O46 | وصول وتأجيل الدفع ثم تحصيل وخروج وإعادة توقيع | المطلوب الآن صحيح بعد المقبوض؛ لا مضاعفة سند أو قسط ولا اعتبار التأجيل سدادًا |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R577 — ع. اختبارات القبول الإلزامية

المطلب: | O47 | خصم/تعديل/إلغاء اتفاق أو عكس قبض دون صلاحية | رفض خادمي وتدقيق مناسب؛ عند الصلاحية إصدار/تسوية موثقة لا محو للتاريخ |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R578 — ع. اختبارات القبول الإلزامية

المطلب: | O48 | مثبت ضمن الاتفاق مع طلب مختبر وتخصص آخر | تكلفة المختبر لا تضاعف فاتورة المريض، والطبيب المنفذ وتغطية كل بند والعمولة من مصدرها الصحيح |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R579 — ع. اختبارات القبول الإلزامية

المطلب: | O49 | تقرير مالي وعرض علمي للحالة نفسها | المطابقة الحسابية حسب العملة في التقرير؛ تفاصيل الاتفاق لا تتسرب افتراضيًا للعرض العلمي |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R580 — ع. اختبارات القبول الإلزامية

المطلب: | O50 | فتح دراستين لمريضين مختلفين وتصديرهما | اسم المركز وهوية كل مريض صحيحان؛ لا اسم للحالة المرجعية في القالب أو الأزرار ولا تسرب بيانات بين المريضين |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R581 — ع. اختبارات القبول الإلزامية

المطلب: | O51 | تعبئة الدراسة وقص الصور ثم إغلاق المتصفح دون تصدير | الدراسة والقياسات والصور وتعديلات القص واختيارات العرض محفوظة؛ تُفتح من جهاز آخر وتُصدّر لاحقًا دون إعادة الإدخال |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R582 — ع. اختبارات القبول الإلزامية

المطلب: | O52 | توثيق نسخة دراسة ثم تعديل المصدر أو فشل التصدير | النسخة الموثقة ثابتة، والتحديث بإصدار جديد؛ فشل التصدير لا يضيع التوثيق أو يُجبر على إعادة التعبئة |

الملكية: lead QA + root/publisher
المسارات: unit/PostgreSQL/security-HTTP/browser suites
القبول المطلوب: all O01-O52
الحالة: not started
التفصيل: all_new_scope_acceptance_open
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R592 — ف. ما يجب تسليمه داخل المستودع

المطلب: 1. كود فعلي مترابط دون TODOs في مسارات أساسية أو أزرار وهمية.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R593 — ف. ما يجب تسليمه داخل المستودع

المطلب: 2. ترحيلات وسكربتات نقل/تحقق عند الحاجة، وتقرير البيانات الملتبسة، وسياسة رجوع متوافقة.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R594 — ف. ما يجب تسليمه داخل المستودع

المطلب: 3. ملف مثل `docs/ORTHO_CEPH_IMPLEMENTATION_PLAN_AR.md` يربط كل مطلب في هذه الوثيقة بالملف/المسار/الاختبار وحالة الإنجاز.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R595 — ف. ما يجب تسليمه داخل المستودع

المطلب: 4. مخطط علاقات وملكية بيانات وقاموس حقول، ومعايير المعادلات والمراجع وإصداراتها. قرارات معمارية موجزة لأسباب التمديد أو إعادة الاستخدام.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R596 — ف. ما يجب تسليمه داخل المستودع

المطلب: 5. عقود API والتحقق والصلاحيات وحالات الأخطاء والتزامن، لا مواصفات شاشة وحدها.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R597 — ف. ما يجب تسليمه داخل المستودع

المطلب: 6. أدلة الاختبار: SHA والأوامر والنتائج والبيئة والموانع، ولقطات من بيانات اصطناعية. الملف الذي يحتوي صور المريضة المرجعية لا يُرفق في PR.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R598 — ف. ما يجب تسليمه داخل المستودع

المطلب: 7. نموذج PPTX قابل للتحرير وPDF مطابق من حالة اصطناعية طويلة، مع فحص بصري وتقرير خصوصية للمحتوى المضمن.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R599 — ف. ما يجب تسليمه داخل المستودع

المطلب: 8. دليل مختصر للطبيب والمساعد والاستقبال: فتح حالة، استكمال قديمة، زيارة يومية، تحليل واعتماد، تثبيت، وتصدير.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R600 — ف. ما يجب تسليمه داخل المستودع

المطلب: 9. تحديث README بروابط الوثائق وطريقة التشغيل والاختبار والوضع الحقيقي. لا يبقى فارغًا ولا يدعي اكتمال ما لم يُنجز.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

### V2R601 — ف. ما يجب تسليمه داخل المستودع

المطلب: 10. تقرير ختامي يفصل «نُفذ واختُبر»، «نُفذ ولم يُختبر بسبب مانع محدد»، و«متبقٍ». لا تعلن اكتمال النطاق مع تجاهل تحليل أو مسار مطلوب، ولا تضمن خلو البرنامج من الأخطاء.

الملكية: lead/docs + all domain owners
المسارات: docs; README; source/test/migration/artifact packets
القبول المطلوب: full final matrix
الحالة: not started
التفصيل: pending
دليل التنفيذ: لم يُنفّذ ضمن هذه الحزمة.

## مصفوفة القبول O01–O52

### O01 — مريض جديد ← تقييم ← صور ← خطة ← زيارة

النتيجة المطلوبة: حالة وسياق واحد، دون تكرار الهوية أو التشخيص أو الزيارة
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O02 — مريض بدأ التقويم قبل النظام ولا تتوفر سجلات أولية

النتيجة المطلوبة: إدخال ملخص سابق بتواريخه المعلومة دون اختراع T1 أو زيارات
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O03 — حالتان للمريض نفسه/صورة غير مرتبطة

النتيجة المطلوبة: لا اختلاط في السجلات أو السيفالو أو التصدير؛ ربط صريح فقط
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O04 — تبديل مريض/حالة أو سحب إذن أثناء الطلب

النتيجة المطلوبة: لا ظهور بيانات في السياق الآخر ولا قبول كتابة غير مصرح بها
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O05 — فقد رد الحفظ ثم إعادة المحاولة

النتيجة المطلوبة: لا تتكرر الزيارة أو IPR أو دفعة الاستيراد؛ تظهر النتيجة غير المؤكدة
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O06 — طبيبان يعدلان الخطة أو الدراسة

النتيجة المطلوبة: كشف تعارض أو تسلسل آمن، دون ضياع صامت للتعديلات
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O07 — إدخال زيارة قديمة بين زيارات قائمة

النتيجة المطلوبة: الترتيب صحيح، والمعرفات والصور والتواقيع لا تتغير
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O08 — الاحتفاظ بالسلك ثم تغييره/إزالته

النتيجة المطلوبة: التاريخ الفعلي دقيق، والمخطط لا يظهر كأنه مركب
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O09 — صور متعددة للمنظر في تواريخ مختلفة

النتيجة المطلوبة: اختيار المجموعة واضح؛ لا تُعرض كمجموعة زمنية واحدة مصطنعة
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O10 — صورة بلا معايرة أو نقطة لازمة

النتيجة المطلوبة: لا أطوال مؤكدة ولا صفر بديل ولا اعتماد نتيجة ناقصة
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O11 — تصحيح دراسة معتمدة ثم مقارنة متابعة

النتيجة المطلوبة: المعتمد الأصلي ثابت، أصل التصحيح معروف، ومتابعة الصورة الجديدة منفصلة
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O12 — مرجعان/وحدتان/نسختا محرك مختلفتان

النتيجة المطلوبة: تحذير/منع حسب المواصفة، دون فرق رقمي مضلل
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O13 — عمر مجهول وفشل AI وقياسات ناقصة

النتيجة المطلوبة: لا افتراض نمو أو نتائج طبيعية أو توصية معتمدة تلقائيًا
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O14 — Bolton ومجموع الأسنان وفرق المساحة

النتيجة المطلوبة: نتائج مقابل أمثلة مستقلة موثقة، مع اختبارات التقريب والأسنان المفقودة والقيم الحدية
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O15 — تحليل مختلط للفكين ومقياس شعاعي

النتيجة المطلوبة: لا خلط لمجاميع الفكين؛ جداول/معادلات وإصدارات ومعايرة صحيحة
الحالة: blocked
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.
المانع المحدد: Exact mixed-dentition primary methods/reference sets and clinical approval unresolved; no inferred equations.

### O16 — IPR لنفس التماس في زيارتين وإعادة إرسال الطلب

النتيجة المطلوبة: المجموع صحيح بلا تضاعف، ومخطط/منفذ متمايزان
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O17 — تعديل خطة موقعة ورفض المريض بديلًا

النتيجة المطلوبة: إصدار وتدقيق وموافقة مرتبطة بالنسخة المناسبة
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O18 — مثبتان مختلفان للفكين وتسليم بتاريخ قديم

النتيجة المطلوبة: حفظ مستقل وتاريخ فعلي، لا كتابة اليوم أو استبدال أحدهما بالآخر
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O19 — مثبت ثابت ومتحرك للفك نفسه ثم استبدال

النتيجة المطلوبة: تاريخ أجهزة كامل، والمراجعة مرتبطة بالجهاز الصحيح
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O20 — تثبيت منتظم وآخر شدّة قديمة

النتيجة المطلوبة: قائمة المتابعة تعتمد استحقاق التثبيت، بلا إنذار انقطاع آلي من عداد الشدّات
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O21 — حالة مرجعية اصطناعية طويلة بزيارات كثيرة

النتيجة المطلوبة: PPTX وPDF يطابقان ترتيب A ومصادر الحالة، دون 43 شريحة مفروضة
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O22 — استكمال بيانات أثناء توليد عرض

النتيجة المطلوبة: نسخة متسقة من لقطة محددة، لا محتوى هجين
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O23 — PPTX عربي وإنجليزي مع جدول طويل وصور

النتيجة المطلوبة: نص وجداول قابلة للتحرير؛ لا قص أو تداخل؛ فتح فعلي في عارضين
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O24 — عرض مسودة/نهائي به بيانات غير معتمدة

النتيجة المطلوبة: توضيح الحالة وعدم تمرير مسودة على أنها نتيجة معتمدة
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O25 — تصدير تعليمي مع صور وmetadata

النتيجة المطلوبة: فحص محتويات ZIP والملفات المضمنة وعدم تسرب هوية مخفية تحت القص أو في notes
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O26 — سحب إذن الصور/التصدير بعد بدء المهمة

النتيجة المطلوبة: التوليد/التنزيل يحترمان الصلاحية الحالية دون تسرب الملفات
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O27 — استيراد ملف قديم مرتين مع بعض الصفوف الخاطئة

النتيجة المطلوبة: لا تكرار، تقرير رفض وتطابق واضح، واستكمال آمن للدفعة
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O28 — حفظ زيارة وتصدير واستيراد مع اتفاق SAR وسداد YER

النتيجة المطلوبة: لا تغيير في الفواتير والسندات أو إعادة حساب مالي من قسم التقويم
الحالة: blocked
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.
المانع المحدد: SAR agreement paid in YER is unsupported by current canonical writers; no substitute Ortho conversion/ledger.

### O29 — Staging بها قالب رسالة وتذكير

النتيجة المطلوبة: لا رسالة إلى مريض حقيقي؛ أثر الاختبار ظاهر بمستقبل اختبار
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O30 — ترحيل على PostgreSQL ثم نشر/رجوع/استعادة

النتيجة المطلوبة: سلامة البيانات والقيود والتواريخ والروابط، مع دليل استعادة فعلي
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O31 — تعبئة حالة اصطناعية ثم اختيار قالب دراسة الحالة الخاص بالمركز

النتيجة المطلوبة: الشرائح الأساسية وتوزيع الصور والجداول مماثلة للمرجع وفق جدول المطابقة، دون ترتيب خارجي يدوي
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O32 — رفع دفعة صور وتصحيح اقتراح تصنيفها

النتيجة المطلوبة: تعيين صحيح للمناظر والحالة والزيارة، وتعديل سهل دون فقد المصدر
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O33 — قص وتدوير صورة ذات اتجاه EXIF ثم إعادة فتحها

النتيجة المطلوبة: إعادة إنتاج دقيقة للتحويل، وأصل محفوظ وقابل للرجوع
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O34 — صورة واحدة بقصين مختلفين في لوحتين

النتيجة المطلوبة: استخدامان مستقلان من الأصل نفسه؛ تغيير أحدهما لا يفسد الآخر
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O35 — معاينة ثم PPTX ثم PDF لصورة مقصوصة

النتيجة المطلوبة: تطابق القص والحجم النسبي والاتجاه دون تمدد أو دقة رديئة غير مبينة
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O36 — قص صورة مستخدمة في سيفالو معتمد لأجل العرض

النتيجة المطلوبة: لا تتغير المعالم أو المعايرة أو القياسات المعتمدة
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O37 — صورة لا يمكن قصها بأمان لخانة القالب

النتيجة المطلوبة: اختيار الاحتواء أو المراجعة؛ لا حذف منطقة سريرية مهمة بصمت
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O38 — وصول مريض جديد ثم إكمال رحلة التقييم خطوة بخطوة

النتيجة المطلوبة: نفس هوية المريض والحالة تتبع المقابلة والفحص خارج/داخل الفم والقياسات والبانوراما والسيفالو والخطة؛ استئناف آمن بعد الانقطاع
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O39 — إدخال قياسات الأسنان والقوس مرة واحدة واختيار عدة تحليلات

النتيجة المطلوبة: تشغيل التحليلات الجاهزة آليًا دون إدخال مجاميع/نتائج يدويًا؛ ما يحتاج مدخلات إضافية يطلبها تحديدًا ولا يخمنها
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O40 — تعديل قياس بعد اعتماد تحليل وتصدير عرض

النتيجة المطلوبة: إعادة حساب المسودات المرتبطة مع حفظ النسخة المعتمدة والعرض السابق؛ النسخة الجديدة تستخدم نتيجة جديدة ذات مصدر معروف
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O41 — اعتماد اتفاق وجدولة أقساطه

النتيجة المطلوبة: جدول يطابق صافي الاتفاق دون إنشاء دين إضافي؛ الدفعة المخططة لا تُسجل قبضًا
الحالة: blocked
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.
المانع المحدد: Canonical invoice-backed schedule-only collection extension is not implemented; current invoice-on-collection writer intentionally refuses invoice-backed items.

### O42 — اتفاق قديم له رصيد/سندات سابقة ثم إعادة ربطه

النتيجة المطلوبة: مصدر مديونية واحد وتقرير مطابقة؛ لا ازدواج في المبلغ ولا قبض تاريخي داخل صندوق اليوم
الحالة: blocked
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.
المانع المحدد: Historical shared opening balance has no proven per-agreement allocation; cannot claim exact case remaining.

### O43 — اتفاق SAR وسداد YER أو USD وتغيير سعر الإعدادات

النتيجة المطلوبة: مبلغ صندوق فعلي وتخصيص بعملة الفاتورة وسعر تاريخي ثابت مع اتجاه ووحدة واضحين
الحالة: blocked
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.
المانع المحدد: Current canonical writers refuse YER/USD receipt against non-YER debt; approved source/target FX extension is still needed.

### O44 — تحصيل جزئي/مقدم/متعدد العملات ثم إعادة المحاولة

النتيجة المطلوبة: تخصيصات صحيحة، سند واحد، فرق تقريب معلن، وعدم تجاوز السياسة المالية للزيادة
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O45 — شدّة مشمولة وعمل إضافي في الزيارة نفسها

النتيجة المطلوبة: المشمولة لا تُفوتر ثانية؛ الإضافي يحتاج قرار سعر/موافقة ومصدر مطالبة واضحًا
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O46 — وصول وتأجيل الدفع ثم تحصيل وخروج وإعادة توقيع

النتيجة المطلوبة: المطلوب الآن صحيح بعد المقبوض؛ لا مضاعفة سند أو قسط ولا اعتبار التأجيل سدادًا
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O47 — خصم/تعديل/إلغاء اتفاق أو عكس قبض دون صلاحية

النتيجة المطلوبة: رفض خادمي وتدقيق مناسب؛ عند الصلاحية إصدار/تسوية موثقة لا محو للتاريخ
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O48 — مثبت ضمن الاتفاق مع طلب مختبر وتخصص آخر

النتيجة المطلوبة: تكلفة المختبر لا تضاعف فاتورة المريض، والطبيب المنفذ وتغطية كل بند والعمولة من مصدرها الصحيح
الحالة: not started
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O49 — تقرير مالي وعرض علمي للحالة نفسها

النتيجة المطلوبة: المطابقة الحسابية حسب العملة في التقرير؛ تفاصيل الاتفاق لا تتسرب افتراضيًا للعرض العلمي
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O50 — فتح دراستين لمريضين مختلفين وتصديرهما

النتيجة المطلوبة: اسم المركز وهوية كل مريض صحيحان؛ لا اسم للحالة المرجعية في القالب أو الأزرار ولا تسرب بيانات بين المريضين
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O51 — تعبئة الدراسة وقص الصور ثم إغلاق المتصفح دون تصدير

النتيجة المطلوبة: الدراسة والقياسات والصور وتعديلات القص واختيارات العرض محفوظة؛ تُفتح من جهاز آخر وتُصدّر لاحقًا دون إعادة الإدخال
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.

### O52 — توثيق نسخة دراسة ثم تعديل المصدر أو فشل التصدير

النتيجة المطلوبة: النسخة الموثقة ثابتة، والتحديث بإصدار جديد؛ فشل التصدير لا يضيع التوثيق أو يُجبر على إعادة التعبئة
الحالة: in progress
دليل التنفيذ: لم يبدأ التنفيذ في هذه الحزمة.


## تنقية النص للنشر العام
هذه المصفوفة متطلبات تنفيذية فقط. حُذفت معرفات المرفق الخاصة، وعُمّم اسم مريضة المرجع إلى «الحالة المرجعية» في مطلب واحد. بقيت بصمة المصدر وأرقام الأسطر للتحقق، دون صور أو سجلات مرضى أو روابط تنزيل خاصة.

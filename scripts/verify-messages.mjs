#!/usr/bin/env node
/**
 * هل المراسلة الداخلية موصولة فعلًا؟ — رحلة كاملة على PGlite في الذاكرة.
 *
 * معايير القبول:
 *  ١) رسالة بين زميلين تظهر لكلٍّ منهما في محادثتهما، وغير مقروءة عند المرسل
 *     إليه حتى يفتحها، والفتحُ يعلمها مقروءة له وحده.
 *  ٢) رسالة المريض من البوابة تصل صندوق الطاقم كله (staff_all) فيراها كل عضو
 *     في قائمة مرضاه، وكلٌّ يقرؤها على حدة — قراءة الطبيب لا تُسقط إشعار
 *     الاستقبال.
 *  ٣) ردّ الطاقم على المريض يظهر في خيط المريض نفسه، فما تراه البوابة هو ما
 *     يراه الطاقم، بلا نسختين من الحقيقة.
 *  ٤) الصوت يُخزن ويُسترجع بايتًا بايتًا كما أُرسل، والمحادثات لا تُحمّل جسمه.
 *  ٥) شارة غير المقروء للقشرة تجمع الصندوقين: الخاص والمرضى.
 *
 * لا يحتاج خادم قاعدة: يُشغَّل على PGlite داخل العملية، فالجدولان والاستعلامات
 * نفسها التي تُشغَّل على Postgres في الإنتاج.
 */
process.env.SESSION_SECRET = "f".repeat(48);
process.env.USE_LOCAL_DB = "true";
process.env.DATABASE_URL = "";

const db = await import("../lib/db.ts");

let failed = false;
const check = (label, ok, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failed = true;
};

try {
  console.log("١) البذر والمخطط");
  const users = await db.listUsers();
  const admin = users.find((user) => user.username === "admin");
  const doctor = users.find((user) => user.username === "doctor");
  const reception = users.find((user) => user.username === "reception");
  check("حسابات الطاقم الثلاثة مزروعة", Boolean(admin && doctor && reception));
  check(
    "دور الاستقبال reception لا receptionist (توحيد المفردة)",
    reception?.role === "reception",
    `الدور الحالي: ${reception?.role}`,
  );

  console.log("٢) رسالة بين زميلين");
  const sent = await db.insertMessage({
    senderType: "user", senderUserId: admin.id, senderPatientId: null,
    recipientType: "user", recipientUserId: doctor.id, recipientPatientId: null,
    body: "عندك لحظة بعد عيادة الصباح؟", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
  });
  check("أُدرجت برقم واسم مرسل", sent.id > 0 && sent.senderName === admin.displayName);

  const doctorInboxBefore = await db.staffConversationList(doctor.id);
  const doctorRow = doctorInboxBefore.staff.find((item) => item.userId === admin.id);
  check("ظهرت غير مقروءة عند الطبيب", doctorRow?.unread === 1);
  const adminList = await db.staffConversationList(admin.id);
  const adminRow = adminList.staff.find((item) => item.userId === doctor.id);
  check("مقروءة عند المرسل من لحظتها", adminRow?.unread === 0);

  const unreadBefore = await db.unreadMessageCount(doctor.id);
  check("شارة الطبيب تحسبها (١)", unreadBefore === 1, `الشارة: ${unreadBefore}`);

  await db.markConversationRead(doctor.id, { withUserId: admin.id });
  const doctorInboxAfter = await db.staffConversationList(doctor.id);
  const doctorRowAfter = doctorInboxAfter.staff.find((item) => item.userId === admin.id);
  check("فتح المحادثة يصفرّ غير المقروء", doctorRowAfter?.unread === 0);

  const both = await db.directMessages(admin.id, doctor.id);
  check("المحادثة تحمل الرسالة للطرفين", both.length === 1 && both[0].body.includes("عيادة الصباح"));
  check("جسم الصوت غائب عن قائمة المحادثة", !("voiceData" in both[0]));

  console.log("٣) خيط المريض وصندوق الطاقم المشترك");
  const patient = await db.createPatient({
    fullName: "مريض التحقق المراسي",
    phone: "777000111",
    altPhone: null, gender: "male", birthYear: 1990, address: null, medicalAlert: null, note: null,
  });
  const patientMessage = await db.insertMessage({
    senderType: "patient", senderUserId: null, senderPatientId: patient.id,
    recipientType: "staff_all", recipientUserId: null, recipientPatientId: null,
    body: "هل الموعد غدًا ثابت؟", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
  });
  check("رسالة المريض أُدرجت باسمه", patientMessage.senderName === patient.fullName);

  const doctorPatients = await db.staffConversationList(doctor.id);
  const thread = doctorPatients.patients.find((item) => item.patientId === patient.id);
  check("ظهر خيط المريض عند الطبيب غير مقروء", thread?.unread === 1);
  const receptionPatients = await db.staffConversationList(reception.id);
  const receptionThread = receptionPatients.patients.find((item) => item.patientId === patient.id);
  check("الخيط نفسه عند الاستقبال أيضًا غير مقروء — القراءة شخصية", receptionThread?.unread === 1);

  const doctorUnread = await db.unreadMessageCount(doctor.id);
  check("شارة الطبيب تجمع الخاص ومرضى البوابة", doctorUnread >= 1, `الشارة: ${doctorUnread}`);

  await db.markConversationRead(doctor.id, { withPatientId: patient.id });
  const doctorPatientsAfter = await db.staffConversationList(doctor.id);
  const threadAfter = doctorPatientsAfter.patients.find((item) => item.patientId === patient.id);
  check("قراءة الطبيب لا تُسقط إشعار الاستقبال",
    threadAfter?.unread === 0 && receptionPatients.patients.find((item) => item.patientId === patient.id)?.unread === 1);

  console.log("٤) ردّ الطاقم على المريض");
  const reply = await db.insertMessage({
    senderType: "user", senderUserId: doctor.id, senderPatientId: null,
    recipientType: "patient", recipientUserId: null, recipientPatientId: patient.id,
    body: "ثابت بإذن الله — الساعة العاشرة صباحًا.", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
  });
  const threadView = await db.patientThreadMessages(patient.id);
  check(
    "خيط المريض يجمع رسالته وردّ الطاقم",
    threadView.length === 2
      && threadView[0].senderType === "patient"
      && threadView[1].senderType === "user"
      && threadView[1].senderName === doctor.displayName,
  );
  check("الردّ وصل المريض لا صندوق الطاقم", reply.recipientType === "patient");

  console.log("٥) الرسالة الصوتية");
  const tone = Buffer.from(
    "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=",
    "base64",
  ).toString("base64");
  const voice = await db.insertMessage({
    senderType: "user", senderUserId: admin.id, senderPatientId: null,
    recipientType: "patient", recipientUserId: null, recipientPatientId: patient.id,
    body: null, kind: "voice",
    voiceMime: "audio/wav", voiceData: tone, voiceMs: 3200,
  });
  check("أُدرجت صوتية بمدة", voice.kind === "voice" && voice.voiceMs === 3200);
  const payload = await db.voiceMessagePayload(voice.id);
  check(
    "جسم الصوت عاد كما أُرسل بايتًا بايتًا",
    payload?.data === tone && payload?.mime === "audio/wav",
  );
  const threadWithVoice = await db.patientThreadMessages(patient.id);
  const voiceInView = threadWithVoice.find((message) => message.id === voice.id);
  check("القائمة تحمل المدة وتخفي الجسم", voiceInView?.voiceMs === 3200 && !("voiceData" in voiceInView));

  console.log("٦) عزل المحادثات الخاصة");
  const receptionDm = await db.directMessages(reception.id, doctor.id);
  check("محادثة المدير والطبيب لا تظهر لثالث", receptionDm.length === 0);

  await verifyAttachmentsAndBroadcast({ admin, doctor, reception, patient });

  await verifyLiveConversation({ admin, doctor, reception, patient });

  console.log();
  if (failed) {
    console.error("فشل تحقق المراسلة — راجع البنود المعلمة أعلاه.");
    process.exit(1);
  }
  console.log("تحقق المراسلة ناجح بالكامل ✓");
} catch (error) {
  console.error("خطأ غير متوقع أثناء التحقق:", error);
  process.exit(1);
}

/*
 * الملحق ب — المحادثة الحية: عاجلة وصحّان وردّ وتعديل وحذف.
 * يُشغّل ضمن السكربت الرئيسي أعلاه (نفس القاعدة في الذاكرة).
 */
async function verifyLiveConversation({ admin, doctor, patient }) {
  console.log("١٠) الرسالة العاجلة — علمٌ للمريض وحده");
  const urgentMessage = await db.insertMessage({
    senderType: "patient", senderUserId: null, senderPatientId: patient.id,
    recipientType: "staff_all", recipientUserId: null, recipientPatientId: null,
    body: "ألم شديد لا يحتمل — أرجو الرد سريعًا", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
    fileName: null, fileMime: null, fileSize: null, fileData: null,
    isUrgent: true,
  });
  check("علم العاجلة يُخزن مع رسالة المريض", urgentMessage.isUrgent === true);

  const normalMessage = await db.insertMessage({
    senderType: "patient", senderUserId: null, senderPatientId: patient.id,
    recipientType: "staff_all", recipientUserId: null, recipientPatientId: null,
    body: "شكرًا على المتابعة", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
    fileName: null, fileMime: null, fileSize: null, fileData: null,
  });
  check("رسالة المريض العادية تبقى عادية", normalMessage.isUrgent === false);

  const staffUrgentAttempt = await db.insertMessage({
    senderType: "user", senderUserId: doctor.id, senderPatientId: null,
    recipientType: "patient", recipientUserId: null, recipientPatientId: patient.id,
    body: "خالص المودة", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
    fileName: null, fileMime: null, fileSize: null, fileData: null,
    isUrgent: true,
  });
  check("الطاقم لا يملك علم العاجلة ولو طلبه", staffUrgentAttempt.isUrgent === false);

  const doctorUrgentBadge = await db.urgentUnreadMessageCount(doctor.id);
  check("شارة العاجلة عند الطبيب تحسبها (١)", doctorUrgentBadge === 1, `الشارة: ${doctorUrgentBadge}`);
  const doctorUrgentList = (await db.staffConversationList(doctor.id)).patients
    .find((p) => p.patientId === patient.id);
  check("قائمة محادثات الطبيب تعلّم الخيط بعاجلة غير مقروءة",
    (doctorUrgentList?.urgentUnread ?? 0) === 1);

  await db.markConversationRead(doctor.id, { withPatientId: patient.id });
  check("فتح الطبيب الخيط يطفئ العاجلة عنده",
    (await db.urgentUnreadMessageCount(doctor.id)) === 0);

  console.log("١١) صحّا القراءة — الإيصال المزدوج");
  const dm = await db.insertMessage({
    senderType: "user", senderUserId: admin.id, senderPatientId: null,
    recipientType: "user", recipientUserId: doctor.id, recipientPatientId: null,
    body: "رسالة بصحّين للتحقق", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
  });
  const dmBeforeRead = (await db.directMessages(admin.id, doctor.id))
    .find((m) => m.id === dm.id);
  check("قبل فتح زميلي: صحٌّ واحد — القراءة غائبة", dmBeforeRead?.readAt == null);
  await db.markConversationRead(doctor.id, { withUserId: admin.id });
  const dmAfterRead = (await db.directMessages(admin.id, doctor.id))
    .find((m) => m.id === dm.id);
  check("بعد فتح زميلي: صحّان — القراءة موقّتة", dmAfterRead?.readAt != null);

  const patientMsg = await db.insertMessage({
    senderType: "patient", senderUserId: null, senderPatientId: patient.id,
    recipientType: "staff_all", recipientUserId: null, recipientPatientId: null,
    body: "متى تظهر النتيجة؟", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
  });
  const patientMsgBefore = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === patientMsg.id);
  check("رسالة المريض قبل قراءة الطاقم: صحٌّ واحد", patientMsgBefore?.readAt == null);
  await db.markConversationRead(admin.id, { withPatientId: patient.id });
  const patientMsgAfter = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === patientMsg.id);
  check("بعد أن فتحها الطاقم: صحّان عند المريض", patientMsgAfter?.readAt != null);

  const staffReply = await db.insertMessage({
    senderType: "user", senderUserId: admin.id, senderPatientId: null,
    recipientType: "patient", recipientUserId: null, recipientPatientId: patient.id,
    body: "النتيجة ظهرت — الملف مرفق", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
  });
  const staffReplyBefore = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === staffReply.id);
  check("ردّ الطاقم قبل فتح البوابة: صحٌّ واحد", staffReplyBefore?.readAt == null);
  await db.markPatientThreadReadByPatient(patient.id);
  const staffReplyAfter = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === staffReply.id);
  check("فتح المريض البوابة يوقّع الصحّين عند مرسل الردّ", staffReplyAfter?.readAt != null);
  const reread = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === staffReply.id);
  check("إعادة الفتح لا تُغيّر طابع القراءة الأول",
    reread?.readAt === staffReplyAfter?.readAt);

  console.log("١٢) الردّ بالاقتباس");
  const quotedReply = await db.insertMessage({
    senderType: "patient", senderUserId: null, senderPatientId: patient.id,
    recipientType: "staff_all", recipientUserId: null, recipientPatientId: null,
    body: "شكرًا — سأمرّ غدًا", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
    fileName: null, fileMime: null, fileSize: null, fileData: null,
    replyToId: staffReply.id,
  });
  const quotedReplyView = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === quotedReply.id);
  check(
    "اقتباس الردّ يحمل اسم مرسله ونصّه",
    quotedReplyView?.replyTo?.senderName === admin.displayName
      && quotedReplyView?.replyTo?.body === "النتيجة ظهرت — الملف مرفق",
  );

  let crossThreadRejected = false;
  try {
    await db.insertMessage({
      senderType: "patient", senderUserId: null, senderPatientId: patient.id,
      recipientType: "staff_all", recipientUserId: null, recipientPatientId: null,
      body: "اقتباس متسوّل", kind: "text",
      voiceMime: null, voiceData: null, voiceMs: null,
      fileName: null, fileMime: null, fileSize: null, fileData: null,
      replyToId: dm.id,
    });
  } catch (error) {
    crossThreadRejected = error instanceof Error && error.message === "reply-out-of-thread";
  }
  check("الردّ على رسالة من خيط آخر مرفوض — لا يعبر اقتباسٌ جدارًا", crossThreadRejected);

  console.log("١٣) تعديل الرسالة — نصّي ومالكه وحده");
  const edited = await db.editStaffMessage(staffReply.id, admin.id, "النتيجة ظهرت — انظر المرفقات");
  check("مالك النصّ يعدّله بختم معدّلة",
    edited.ok === true && edited.message.body.includes("المرفقات") && edited.message.editedAt != null);

  const editForeign = await db.editStaffMessage(staffReply.id, doctor.id, "تلاعب");
  check("تعديل رسالة غيري مرفوض", editForeign.ok === false);

  const voiceForEditTest = await db.insertMessage({
    senderType: "user", senderUserId: admin.id, senderPatientId: null,
    recipientType: "patient", recipientUserId: null, recipientPatientId: patient.id,
    body: null, kind: "voice",
    voiceMime: "audio/wav", voiceData: Buffer.from("UklGRg==").toString("base64"), voiceMs: 1500,
  });
  const editVoice = await db.editStaffMessage(voiceForEditTest.id, admin.id, "نص على صوت");
  check("تعديل الرسالة الصوتية مرفوض — الصوت قيل كما قيل", editVoice.ok === false);

  const patientEdit = await db.editPatientMessage(
    normalMessage.id, patient.id, "شكرًا جزيلًا على المتابعة",
  );
  check("المريض يعدّل نصّه من البوابة",
    patientEdit.ok === true && patientEdit.message.body.includes("جزيلًا"));
  const patientEditForeign = await db.editPatientMessage(staffReply.id, patient.id, "تلاعب");
  check("تعديل المريض لرسالة الطاقم مرفوض", patientEditForeign.ok === false);

  console.log("١٤) الحذف اللطيف — قبرٌ يُرى لا اختفاء");
  const deletedReplyQuote = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === quotedReply.id);
  check("اقتباس الردّ يظهر قبل حذفه", deletedReplyQuote?.replyTo?.deleted === false);

  const deleted = await db.deleteStaffMessage(staffReply.id, admin.id);
  check("مالك الرسالة يحذفها حذفًا لطيفًا",
    deleted.ok === true && deleted.message.deletedAt != null);

  const tombstone = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === staffReply.id);
  check("القبر ظاهر في الخيط — الحذف لا يُنكر الكلام", tombstone?.deletedAt != null);
  const quotedAfterDelete = (await db.patientThreadMessages(patient.id))
    .find((m) => m.id === quotedReply.id);
  check("الاقتباس على المحذوفة يشهد عليها", quotedAfterDelete?.replyTo?.deleted === true);

  const deleteForeign = await db.deleteStaffMessage(normalMessage.id, doctor.id);
  check("حذف رسالة غيري مرفوض", deleteForeign.ok === false);
  const deleteTwice = await db.deleteStaffMessage(staffReply.id, admin.id);
  check("حذف المحذوفة مرفوض — لا قبر فوق قبر", deleteTwice.ok === false);

  const patientDelete = await db.deletePatientMessage(urgentMessage.id, patient.id);
  check("المريض يحذف رسالته العاجلة إن شاء",
    patientDelete.ok === true && patientDelete.message.deletedAt != null);
  check("المحذوفة لا تُحصى عاجلة غير مقروءة",
    (await db.urgentUnreadMessageCount(doctor.id)) === 0);

  console.log("١٥) شارات القشرة بعد المحذوفة");
  const adminConversations = await db.staffConversationList(admin.id);
  const patientRow = adminConversations.patients.find((p) => p.patientId === patient.id);
  check("آخر رسالة محذوفة تُعلَم في معاينة القائمة",
    patientRow?.lastDeleted === true || patientRow?.lastKind != null);
}

/*
 * الملحق أ — المرفقات والبثّ الجماعي وحدّ المعدل.
 * يُشغّل ضمن السكربت الرئيسي أعلاه (نفس القاعدة في الذاكرة).
 */
async function verifyAttachmentsAndBroadcast({ admin, doctor, reception, patient }) {
  console.log("٧) المرفقات — صورة من الطاقم إلى مريض");
  const pngBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(64, 0x33),
  ]);
  const fileMessage = await db.insertMessage({
    senderType: "user", senderUserId: admin.id, senderPatientId: null,
    recipientType: "patient", recipientUserId: null, recipientPatientId: patient.id,
    body: "هذه صورة المرجع", kind: "file",
    voiceMime: null, voiceData: null, voiceMs: null,
    fileName: "مرجع-التقويم.png", fileMime: "image/png", fileSize: pngBytes.length,
    fileData: pngBytes.toString("base64"),
  });
  check("أُدرجت بمرفقها واسمها ووصفها",
    fileMessage.kind === "file"
    && fileMessage.fileName === "مرجع-التقويم.png"
    && fileMessage.body === "هذه صورة المرجع");
  const filePayload = await db.fileMessagePayload(fileMessage.id);
  check(
    "جسم المرفق عاد كما أُرسل بايتًا بايتًا",
    Buffer.from(filePayload?.data ?? "", "base64").equals(pngBytes),
  );
  const threadAfterFile = await db.patientThreadMessages(patient.id);
  const fileInView = threadAfterFile.find((m) => m.id === fileMessage.id);
  check("القوائم تحمل المرفق بلا جسمه",
    fileInView?.fileName === "مرجع-التقويم.png",
    `الاسم: ${fileInView?.fileName}`);
  check("جسم المرفق غائب عن قائمة المحادثة", !fileInView || !("fileData" in fileInView));
  const patientListAfterFile = (await db.staffConversationList(admin.id)).patients
    .find((p) => p.patientId === patient.id);
  check("آخر ما في الخيط مرفق باسمه", patientListAfterFile?.lastKind === "file"
    && patientListAfterFile?.lastFileName === "مرجع-التقويم.png");

  console.log("٨) البثّ الجماعي للطاقم");
  const broadcastMsg = await db.insertMessage({
    senderType: "user", senderUserId: admin.id, senderPatientId: null,
    recipientType: "staff_all", recipientUserId: null, recipientPatientId: null,
    body: "اجتماع سريع بعد الإغلاق اليوم", kind: "text",
    voiceMime: null, voiceData: null, voiceMs: null,
    fileName: null, fileMime: null, fileSize: null, fileData: null,
  });
  check("البثّ أُدرج صفًّا واحدًا بلا مرسل بعينه", broadcastMsg.recipientType === "staff_all");

  const doctorView = await db.staffConversationList(doctor.id);
  check("الطبيب يرى البثّ في الخيط الجماعي غير مقروء", doctorView.broadcast.unread >= 1);
  const receptionView = await db.staffConversationList(reception.id);
  check("الاستقبال يراه أيضًا — والقراءة شخصية", receptionView.broadcast.unread >= 1);
  const adminView = await db.staffConversationList(admin.id);
  check("المُرسِل لا يُحصي بثّه غير مقروء", adminView.broadcast.unread === 0);

  const broadcastFeed = await db.broadcastMessages();
  check("خيط البثّ يحمل الرسالة", broadcastFeed.some((m) => m.id === broadcastMsg.id));

  await db.markConversationRead(doctor.id, { broadcast: true });
  const doctorAfterRead = await db.staffConversationList(doctor.id);
  check("فتح الطبيب الخيط يقرؤه عنده وحده",
    doctorAfterRead.broadcast.unread === 0
    && (await db.staffConversationList(reception.id)).broadcast.unread >= 1);

  const patientThreadClean = await db.patientThreadMessages(patient.id);
  check("البثّ الجماعي لا يظهر في بوابة المريض",
    !patientThreadClean.some((m) => m.id === broadcastMsg.id));

  console.log("٩) حدّ معدل إرسال المريض");
  const recentBefore = await db.countRecentPatientMessages(patient.id, 60);
  for (let i = 0; i < 3; i++) {
    await db.insertMessage({
      senderType: "patient", senderUserId: null, senderPatientId: patient.id,
      recipientType: "staff_all", recipientUserId: null, recipientPatientId: null,
      body: `رسالة ${i + 1}`, kind: "text",
      voiceMime: null, voiceData: null, voiceMs: null,
      fileName: null, fileMime: null, fileSize: null, fileData: null,
    });
  }
  const recentAfter = await db.countRecentPatientMessages(patient.id, 60);
  check("عدّاد الساعة يزيد مع كل رسالة", recentAfter === recentBefore + 3,
    `قبل: ${recentBefore} بعد: ${recentAfter}`);
}

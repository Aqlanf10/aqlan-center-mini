"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { Icon } from "@/components/Icon";
import {
  ChatComposer,
  conversationPreview,
  conversationTime,
  daySeparatorLabel,
  MessageBubble,
  playNewMessageChime,
  playUrgentChime,
  type ChatMessage,
} from "@/components/Chat";
import { messagePreview } from "@/lib/messages";
import { ROLE_LABEL, type Role } from "@/lib/roles";

/**
 * شاشة المراسلة — قائمة محادثات ومحادثة واحدة.
 *
 * أقسام ثلاثة: الخيط الجماعي للفريق (بثّ واحد يراه الجميع بقراءة شخصية)،
 * والطاقم (كل زميل نشط، بمن لم تسبق محادثته)، والمرضى (خيط لكل مريض له
 * رسالة، يقرؤه الطاقم جميعًا ويردّ أيٌّ منهم). والتحديث استطلاعٌ كل خمس ثوانٍ
 * ما دامت الشاشة ظاهرة، ونغمةٌ تُنبه عند كل وارد جديد — ونغمة أصرخ للعاجلة —
 * لا حاجة لخادم دفع في عيادةٍ بثلاثة أجهزة.
 */

type ConversationTab = "staff" | "patients";

interface StaffItem {
  userId: number;
  username: string;
  displayName: string;
  role: string;
  lastKind: "text" | "voice" | "file" | null;
  lastBody: string | null;
  lastVoiceMs: number | null;
  lastFileName: string | null;
  lastAt: string | null;
  lastFromMe: boolean;
  lastDeleted?: boolean;
  lastUrgent?: boolean;
  unread: number;
}

interface PatientItem {
  patientId: number;
  patientName: string;
  patientNumber: string;
  phone: string | null;
  lastKind: "text" | "voice" | "file" | null;
  lastBody: string | null;
  lastVoiceMs: number | null;
  lastFileName: string | null;
  lastAt: string | null;
  lastFromPatient: boolean;
  lastDeleted?: boolean;
  lastUrgent?: boolean;
  unread: number;
  urgentUnread?: number;
}

interface BroadcastItem {
  lastMessageId: number | null;
  lastKind: "text" | "voice" | "file" | null;
  lastBody: string | null;
  lastVoiceMs: number | null;
  lastFileName: string | null;
  lastAt: string | null;
  lastFromMe: boolean;
  lastDeleted?: boolean;
  lastUrgent?: boolean;
  lastSenderName: string | null;
  unread: number;
}

interface Active {
  kind: "user" | "patient" | "broadcast";
  id: number;
  title: string;
  subtitle: string;
}

interface ReplyContext {
  id: number;
  name: string;
  preview: string;
}

const POLL_MS = 5_000;

export default function MessagesPage() {
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<ConversationTab>("staff");
  const [staffState, setStaff] = useState<StaffItem[]>([]);
  const [patients, setPatients] = useState<PatientItem[]>([]);
  const [broadcast, setBroadcast] = useState<BroadcastItem | null>(null);
  const [myUserId, setMyUserId] = useState<number | null>(null);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState<Active | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingChat, setLoadingChat] = useState(false);
  const [ready, setReady] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyContext | null>(null);
  const [editing, setEditing] = useState<{ id: number; body: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef<Active | null>(null);
  activeRef.current = active;
  const lastSeenIdRef = useRef<number | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const response = await fetch("/api/messages?conversations=1", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل المحادثات.");
      setStaff(payload.staff ?? []);
      setPatients(payload.patients ?? []);
      setBroadcast(payload.broadcast ?? null);
      if (typeof payload.meUserId === "number") setMyUserId(payload.meUserId);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل المحادثات.");
    } finally {
      setReady(true);
    }
  }, []);

  const chatQuery = useCallback((target: Active): string => {
    if (target.kind === "user") return `withUser=${target.id}`;
    if (target.kind === "patient") return `withPatient=${target.id}`;
    return "broadcast=1";
  }, []);

  const loadChat = useCallback(async (target: Active) => {
    setLoadingChat(true);
    try {
      const response = await fetch(`/api/messages?${chatQuery(target)}`, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.message ?? "تعذّر تحميل المحادثة.");
      setMessages(payload.messages ?? []);
      lastSeenIdRef.current = payload.messages?.at(-1)?.id ?? null;
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "تعذّر تحميل المحادثة.");
    } finally {
      setLoadingChat(false);
    }
  }, [chatQuery]);

  // رابط مباشر لخيط مريض: /messages?patient=12
  useEffect(() => {
    void loadConversations();
    const patientParam = Number(searchParams.get("patient"));
    if (Number.isInteger(patientParam) && patientParam > 0) {
      setTab("patients");
      setActive({
        kind: "patient",
        id: patientParam,
        title: "محادثة مريض",
        subtitle: `ملف رقم ${patientParam}`,
      });
    }
  }, [loadConversations, searchParams]);

  useEffect(() => {
    if (active) void loadChat(active);
  }, [active, loadChat]);

  // استطلاع التحديث ما دامت الشاشة ظاهرة — ونغمة عند كل وارد جديد من غيري،
  // ونغمة الاستغاثة إن كان الوارد العاجلة عاجلة رسالة مريض.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      const target = activeRef.current;
      if (target) {
        void fetch(`/api/messages?${chatQuery(target)}`, { cache: "no-store" })
          .then(async (response) => {
            if (!response.ok) return;
            const payload = await response.json();
            const next: ChatMessage[] = payload.messages ?? [];
            const lastId = next.at(-1)?.id ?? null;
            const prevSeen = lastSeenIdRef.current;
            if (lastId !== null && prevSeen !== null && lastId > prevSeen) {
              const incoming = next.find((message) => message.id > prevSeen
                && !(message.senderType === "user" && message.senderUserId === myUserId));
              if (incoming?.isUrgent) playUrgentChime();
              else if (incoming) playNewMessageChime();
            }
            lastSeenIdRef.current = lastId ?? prevSeen;
            setMessages(next);
          })
          .catch(() => {});
      }
      void loadConversations();
    };
    const timer = setInterval(tick, POLL_MS);
    return () => clearInterval(timer);
  }, [chatQuery, loadConversations, myUserId]);

  // نزول لآخر رسالة عند فتح المحادثة وورود الجديد
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, active]);

  // تبديل المحادثة يهجر الردّ والتعديل — اقتباس خيطٍ في خيطٍ آخر تشويش.
  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
  }, [active]);

  const sendMessage = useCallback(async (payload: {
    body?: string; kind: "text" | "voice" | "file";
    voiceMime?: string; voiceData?: string; voiceMs?: number;
    fileName?: string; fileMime?: string; fileSize?: number; fileData?: string;
    replyToId?: number | null; urgent?: boolean;
  }) => {
    if (!active) return;
    const to = active.kind === "user"
      ? { type: "user", id: active.id }
      : active.kind === "patient"
        ? { type: "patient", id: active.id }
        : { type: "staff_broadcast" };
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, ...payload }),
    });
    const created = await response.json();
    if (!response.ok) throw new Error(created?.message ?? "تعذّر إرسال الرسالة.");
    setMessages((current) => [...current, created as ChatMessage]);
    lastSeenIdRef.current = created.id;
    setReplyTo(null);
    void loadConversations();
  }, [active, loadConversations]);

  const saveEdit = useCallback(async (body: string) => {
    if (!editing) return;
    const response = await fetch("/api/messages", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: editing.id, body }),
    });
    const updated = await response.json();
    if (!response.ok) throw new Error(updated?.message ?? "تعذّر تعديل الرسالة.");
    setMessages((current) => current.map((message) =>
      message.id === editing.id ? (updated as ChatMessage) : message));
    setEditing(null);
    void loadConversations();
  }, [editing, loadConversations]);

  const deleteMessage = useCallback(async (message: ChatMessage) => {
    if (!window.confirm("حذف هذه الرسالة؟ سيظهر مكانها «حُذفت هذه الرسالة» عند الطرف الآخر.")) return;
    const response = await fetch(`/api/messages?id=${message.id}`, { method: "DELETE" });
    const updated = await response.json();
    if (!response.ok) {
      setError(updated?.message ?? "تعذّر حذف الرسالة.");
      return;
    }
    setMessages((current) => current.map((entry) =>
      entry.id === message.id ? (updated as ChatMessage) : entry));
    void loadConversations();
  }, [loadConversations]);

  const startReply = useCallback((message: ChatMessage) => {
    setEditing(null);
    setReplyTo({
      id: message.id,
      name: message.senderName ?? "الرسالة",
      preview: message.deletedAt
        ? "رسالة محذوفة"
        : messagePreview(message.kind, message.body, message.voiceMs, message.fileName,
            { urgent: message.isUrgent }),
    });
  }, []);

  const openStaff = (item: StaffItem) => {
    setActive({
      kind: "user",
      id: item.userId,
      title: item.displayName,
      subtitle: ROLE_LABEL[item.role as Role] ?? item.role,
    });
    setStaff((current) => current.map((entry) =>
      entry.userId === item.userId ? { ...entry, unread: 0 } : entry));
  };

  const openPatient = (item: PatientItem) => {
    setActive({
      kind: "patient",
      id: item.patientId,
      title: item.patientName,
      subtitle: `ملف رقم ${item.patientNumber}`,
    });
    setPatients((current) => current.map((entry) =>
      entry.patientId === item.patientId ? { ...entry, unread: 0 } : entry));
  };

  const openBroadcast = () => {
    setActive({
      kind: "broadcast",
      id: 0,
      title: "الطاقم كلهم",
      subtitle: "رسالة جماعية تصل كل زملائك النشطين",
    });
    setBroadcast((current) => (current ? { ...current, unread: 0 } : current));
  };

  const normalizedFilter = filter.trim();
  const filteredStaff = useMemo(() => {
    if (!normalizedFilter) return staffState;
    return staffState.filter((item) =>
      item.displayName.includes(normalizedFilter) || item.username.includes(normalizedFilter));
  }, [staffState, normalizedFilter]);

  const filteredPatients = useMemo(() => {
    if (!normalizedFilter) return patients;
    return patients.filter((item) =>
      item.patientName.includes(normalizedFilter)
      || item.patientNumber.includes(normalizedFilter)
      || (item.phone ?? "").includes(normalizedFilter));
  }, [patients, normalizedFilter]);

  const totalUnread = patients.reduce((sum, item) => sum + item.unread, 0);
  const totalUrgent = patients.reduce((sum, item) => sum + (item.urgentUnread ?? 0), 0);

  const grouped = useMemo(() => {
    const groups: { label: string; items: ChatMessage[] }[] = [];
    for (const message of messages) {
      const label = daySeparatorLabel(message.createdAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(message);
      else groups.push({ label, items: [message] });
    }
    return groups;
  }, [messages]);

  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="الرسائل"
        subtitle="مراسلة داخلية بين الطاقم — نص وصوت ومرفقات — ورسالة جماعية، ومحادثات المرضى من البوابة"
      />

      {error && (
        <p className="mb-4 rounded-xl border border-danger-200 bg-danger-50 p-3 text-sm font-bold text-danger-800" role="alert">
          {error}
        </p>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 shadow-card lg:flex lg:h-[calc(100vh-13rem)] lg:min-h-[32rem]">
        {/* قائمة المحادثات */}
        <section
          className={`flex min-h-0 flex-col border-slate-200 bg-white lg:w-80 lg:shrink-0 lg:border-l ${
            active ? "hidden lg:flex" : "flex h-[calc(100vh-16rem)]"
          }`}
          aria-label="قائمة المحادثات"
        >
          <div className="border-b border-slate-100 p-3">
            <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setTab("staff")}
                className={`relative rounded-lg py-1.5 text-xs font-black transition-colors ${
                  tab === "staff" ? "bg-white text-navy-900 shadow-xs" : "text-slate-500"
                }`}
              >
                الطاقم
              </button>
              <button
                type="button"
                onClick={() => setTab("patients")}
                className={`relative rounded-lg py-1.5 text-xs font-black transition-colors ${
                  tab === "patients" ? "bg-white text-navy-900 shadow-xs" : "text-slate-500"
                }`}
              >
                المرضى
                {totalUrgent > 0 && (
                  <span className="absolute -top-1 left-2 flex items-center gap-0.5 rounded-full bg-danger-600 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
                    <Icon name="alert" className="h-2.5 w-2.5" />
                    {totalUrgent}
                  </span>
                )}
                {totalUnread > 0 && (
                  <span className={`absolute -bottom-1 left-2 rounded-full px-1.5 py-0.5 text-[10px] font-extrabold text-white ${
                    totalUrgent > 0 ? "bg-accent-500" : "bg-accent-500"
                  }`}>
                    {totalUnread}
                  </span>
                )}
              </button>
            </div>
            <div className="relative">
              <Icon name="search" className="pointer-events-none absolute right-3 top-2.5 h-4 w-4 text-slate-400" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                type="search"
                placeholder="ابحث باسم أو رقم…"
                className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pr-9 pl-3 text-xs text-navy-900 placeholder:text-slate-400 focus:border-navy-400 focus:bg-white focus:outline-none"
                aria-label="بحث في المحادثات"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!ready && <p className="p-4 text-sm text-slate-400">جارٍ التحميل…</p>}
            {ready && tab === "staff" && filteredStaff.length === 0 && !broadcast && (
              <p className="p-4 text-sm text-slate-400">لا زملاء نشطين غيرك — أنشئ حسابات الطاقم من الإعدادات.</p>
            )}
            {ready && tab === "patients" && filteredPatients.length === 0 && (
              <p className="p-4 text-sm text-slate-400">
                لا محادثات مرضى بعد — يبدأ الخيط برسالة من المريض في البوابة، أو بردٍّ منك من ملف المريض.
              </p>
            )}
            {tab === "staff" && broadcast && (
              <ConversationRow
                active={active?.kind === "broadcast"}
                onClick={openBroadcast}
                avatar="كل"
                title="الطاقم كلهم"
                subtitle={`${broadcast.lastSenderName && !broadcast.lastFromMe ? `${broadcast.lastSenderName}: ` : ""}${conversationPreview(broadcast.lastKind, broadcast.lastBody, broadcast.lastVoiceMs, broadcast.lastFileName, { deleted: broadcast.lastDeleted, urgent: broadcast.lastUrgent })}`}
                time={conversationTime(broadcast.lastAt)}
                unread={broadcast.unread}
                highlight
              />
            )}
            {tab === "staff" && filteredStaff.map((item) => (
              <ConversationRow
                key={item.userId}
                active={active?.kind === "user" && active.id === item.userId}
                onClick={() => openStaff(item)}
                avatar={item.displayName.slice(0, 2)}
                title={item.displayName}
                subtitle={`${conversationPreview(item.lastKind, item.lastBody, item.lastVoiceMs, item.lastFileName, { deleted: item.lastDeleted, urgent: item.lastUrgent })}${item.lastFromMe && item.lastKind ? " · أنت" : ""}`}
                time={conversationTime(item.lastAt)}
                unread={item.unread}
              />
            ))}
            {tab === "patients" && filteredPatients.map((item) => (
              <ConversationRow
                key={item.patientId}
                active={active?.kind === "patient" && active.id === item.patientId}
                onClick={() => openPatient(item)}
                avatar={item.patientName.slice(0, 2)}
                title={item.patientName}
                subtitle={`${item.lastFromPatient ? "" : "ردّكم: "}${conversationPreview(item.lastKind, item.lastBody, item.lastVoiceMs, item.lastFileName, { deleted: item.lastDeleted, urgent: item.lastUrgent })}`}
                time={conversationTime(item.lastAt)}
                unread={item.unread}
                urgent={item.urgentUnread ?? 0}
              />
            ))}
          </div>
        </section>

        {/* المحادثة المفتوحة */}
        <section
          className={`flex min-h-0 flex-1 flex-col bg-slate-50 ${active ? "flex h-[calc(100vh-16rem)]" : "hidden lg:flex"}`}
          aria-label="المحادثة"
        >
          {active ? (
            <>
              <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-4 py-3">
                <button
                  type="button"
                  onClick={() => setActive(null)}
                  className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
                  aria-label="عودة للقائمة"
                >
                  <Icon name="back" className="h-5 w-5" />
                </button>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-navy-100 text-xs font-black text-navy-800">
                  {active.title.slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-black text-navy-900">{active.title}</p>
                  <p className="truncate text-[11px] font-semibold text-slate-400">{active.subtitle}</p>
                </div>
                {active.kind === "patient" && (
                  <a
                    href={`/patients/${active.id}`}
                    className="shrink-0 rounded-xl border border-slate-200 px-3 py-1.5 text-[11px] font-bold text-slate-600 hover:border-navy-300 hover:text-navy-900"
                  >
                    ملف المريض
                  </a>
                )}
              </header>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" dir="rtl">
                {loadingChat && <p className="text-center text-sm text-slate-400">جارٍ التحميل…</p>}
                {!loadingChat && messages.length === 0 && (
                  <div className="flex h-full items-center justify-center">
                    <p className="max-w-xs text-center text-sm text-slate-400">
                      لا رسائل بعد — اكتب أول رسالة أو سجّل ملاحظة صوتية بالميكروفون.
                    </p>
                  </div>
                )}
                {grouped.map((group) => (
                  <div key={group.label} className="space-y-2.5">
                    <div className="flex items-center gap-3" aria-hidden="true">
                      <span className="h-px flex-1 bg-slate-200" />
                      <span className="rounded-full bg-white px-3 py-0.5 text-[10px] font-black text-slate-400 shadow-xs">
                        {group.label}
                      </span>
                      <span className="h-px flex-1 bg-slate-200" />
                    </div>
                    {group.items.map((message) => {
                      const mine = message.senderType === "user"
                        && myUserId !== null
                        && message.senderUserId === myUserId;
                      const showSender = active.kind === "broadcast" && !mine && message.senderName;
                      return (
                        <div key={message.id} className="space-y-0.5">
                          {showSender && (
                            <p className={`text-[10px] font-bold ${mine ? "pr-2" : "pr-2"} ${message.isUrgent ? "text-danger-700" : "text-slate-400"}`}>
                              {message.senderName}
                            </p>
                          )}
                          <MessageBubble
                            message={message}
                            mine={mine}
                            onReply={startReply}
                            onEdit={(target) => setEditing({ id: target.id, body: target.body ?? "" })}
                            onDelete={deleteMessage}
                          />
                        </div>
                      );
                    })}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>

              <footer className="border-t border-slate-200 bg-white p-3">
                <ChatComposer
                  onSendText={(body, options) => sendMessage({
                    body, kind: "text",
                    replyToId: options?.replyToId ?? null,
                  })}
                  onSendVoice={(voice, options) => sendMessage({
                    kind: "voice",
                    voiceMime: voice.mime,
                    voiceData: voice.data,
                    voiceMs: voice.ms,
                    replyToId: options?.replyToId ?? null,
                  })}
                  onSendFile={(file, options) => sendMessage({
                    kind: "file",
                    body: file.caption ?? undefined,
                    fileName: file.name,
                    fileMime: file.mime,
                    fileSize: file.size,
                    fileData: file.data,
                    replyToId: options?.replyToId ?? null,
                  })}
                  replyTo={replyTo}
                  onCancelReply={() => setReplyTo(null)}
                  editing={editing}
                  onSaveEdit={saveEdit}
                  onCancelEdit={() => setEditing(null)}
                />
              </footer>
            </>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-navy-100 text-navy-700">
                <Icon name="chat" className="h-7 w-7" />
              </span>
              <p className="text-sm font-black text-navy-900">اختر محادثة لتبدأ</p>
              <p className="max-w-xs text-xs text-slate-400">
                راسل زميلًا من قائمة الطاقم، أو افتح خيط مريض من قائمة المرضى، أو انقر «الطاقم كلهم» لرسالة جماعية — والصوت بالميكروفون والمرفقات بالمشبك.
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function ConversationRow({ active, onClick, avatar, title, subtitle, time, unread, highlight, urgent = 0 }: {
  active: boolean;
  onClick: () => void;
  avatar: string;
  title: string;
  subtitle: string;
  time: string;
  unread: number;
  highlight?: boolean;
  urgent?: number;
}) {
  const burning = urgent > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={`flex w-full items-center gap-3 border-b px-3 py-3 text-right transition-colors ${
        active
          ? "border-navy-100 bg-navy-50"
          : burning
            ? "border-danger-100 bg-danger-50/70 hover:bg-danger-50"
            : "border-slate-50 hover:bg-slate-50"
      }`}
    >
      <span className={`relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-xs font-black ${
        burning
          ? "bg-danger-600 text-white"
          : unread > 0
            ? "bg-navy-800 text-white"
            : highlight ? "bg-brand-orange text-white" : "bg-navy-100 text-navy-800"
      }`}>
        {avatar}
        {burning && (
          <span className="absolute -top-1 -left-1 flex h-4 w-4 items-center justify-center rounded-full bg-danger-600 text-white ring-2 ring-white">
            <Icon name="alert" className="h-2.5 w-2.5" />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center justify-between gap-2">
          <span className={`truncate text-sm font-black ${burning ? "text-danger-800" : "text-navy-900"}`}>{title}</span>
          <span className="shrink-0 text-[10px] font-semibold text-slate-400 tabular-nums">{time}</span>
        </span>
        <span className="mt-0.5 flex items-center justify-between gap-2">
          <span className={`truncate text-xs ${burning ? "font-black text-danger-700" : unread > 0 ? "font-bold text-navy-800" : "text-slate-500"}`}>
            {subtitle}
          </span>
          {burning ? (
            <span className="flex shrink-0 items-center gap-0.5 rounded-full bg-danger-600 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
              <Icon name="alert" className="h-2.5 w-2.5" />
              {urgent}
            </span>
          ) : unread > 0 ? (
            <span className="shrink-0 rounded-full bg-accent-500 px-1.5 py-0.5 text-[10px] font-extrabold text-white">
              {unread}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import {
  formatFileSize,
  formatVoiceDuration,
  MAX_FILE_BYTES,
  MAX_VOICE_MS,
  messagePreview,
} from "@/lib/messages";

/**
 * مكوّنات المحادثة المشتركة — شاشة الطاقم وبوابة المريض على السواء.
 *
 * الفقاعة واحدة، وشريط الإدخال واحد، والمسجّل الصوتي واحد، وزر المرفقات واحد:
 * ما يختلف بين الشاشتين من يرسل وإلى من، لا كيف تبدو الرسالة. والتسجيل
 * بـMediaRecorder كما يسجّله المتصفح (WebM/Opus على كروم وأندرويد، MP4 على
 * سفاري) فيشغّله الجميع بلا سيرفر تحويل، والمرفقات صور وPDF تُعرض الصور منها
 * في الفقاعة ويُنزّل المستند بلمسة.
 */

export interface ChatMessage {
  id: number;
  senderType: "user" | "patient";
  senderUserId: number | null;
  senderPatientId: number | null;
  senderName: string | null;
  recipientType: "user" | "patient" | "staff_all";
  body: string | null;
  kind: "text" | "voice" | "file";
  voiceMs: number | null;
  fileName: string | null;
  fileMime: string | null;
  fileSize: number | null;
  createdAt: string;
}

/** وقت الرسالة كما يُعرض في الفقاعة: 10:42 صباحًا. */
export function messageTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ar-YE", {
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

/** فاصل الأيام: اليوم / أمس / اسم اليوم والتاريخ. */
export function daySeparatorLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (diffDays === 0) return "اليوم";
  if (diffDays === 1) return "أمس";
  return date.toLocaleDateString("ar-YE", {
    weekday: "long", day: "numeric", month: "long",
  });
}

let chimeContext: AudioContext | null = null;

/**
 * نغمة رسالة جديدة — مولّدة برمجيًا لا ملف صوت يُحمّل.
 *
 * المتصفحات تمنع الصوت قبل أول تفاعل، فالنغمة تصمت إن لم يلمس المستخدم الشاشة
 * بعد — سلوكٌ مقبول: من فتح البرنامج وشاشته مغمضة لن يسمع، ومن يعمل عليه
 * يسمع كل وارد. نغمتان قصيرتان صاعدتان تميّزان الرسالة عن نغمة نداء الصالة.
 */
export function playNewMessageChime(): void {
  if (typeof window === "undefined") return;
  try {
    const Ctor = window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!chimeContext || chimeContext.state === "closed") {
      chimeContext = new Ctor();
    }
    if (chimeContext.state === "suspended") {
      void chimeContext.resume();
    }
    const now = chimeContext.currentTime;
    [0, 0.18].forEach((offset, index) => {
      const oscillator = chimeContext!.createOscillator();
      const gain = chimeContext!.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = index === 0 ? 784 : 1046;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.2, now + offset + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.18);
      oscillator.connect(gain).connect(chimeContext!.destination);
      oscillator.start(now + offset);
      oscillator.stop(now + offset + 0.2);
    });
  } catch {
    // متصفح بلا صوت أو سياق مرفوض: الإشعار البصري (الشارة) يبقى.
  }
}

/**
 * مسجّل الرسائل الصوتية — ابدأ، أوقف فأرسل، أو ألغِ.
 *
 * الحد الأعلى دقيقتان يُوقف التسجيل عنده تلقائيًا، والمسار (stream) يُغلق مهما
 * انتهى التسجيل — قبولًا أو إلغاءً — فلا يبقى مؤشر ميكروفونٍ مضيءًا في المتصفح
 * بعد إغلاق المحادثة.
 */
export function useVoiceRecorder(onReady: (voice: {
  data: string; mime: string; ms: number;
}) => Promise<void> | void, onError: (message: string) => void) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [busy, setBusy] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    setRecording(false);
    setElapsedMs(0);
    setBusy(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const pickMime = (): string => {
    if (typeof MediaRecorder === "undefined") return "";
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/mp4",
      "audio/mpeg",
    ];
    for (const candidate of candidates) {
      try {
        if (MediaRecorder.isTypeSupported(candidate)) return candidate;
      } catch {
        // ignore
      }
    }
    return "";
  };

  const start = useCallback(async () => {
    if (recording || busy) return;
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onError("متصفحك لا يدعم تسجيل الصوت — اكتب رسالة نصية.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      onError("متصفحك لا يدعم تسجيل الصوت — اكتب رسالة نصية.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      chunksRef.current = [];
      cancelRef.current = false;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        const durationMs = Date.now() - startedAtRef.current;
        const chunks = chunksRef.current;
        const wasCancelled = cancelRef.current;
        cleanup();
        if (wasCancelled) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) {
          onError("التسجيل فارغ — حاول مرة أخرى.");
          return;
        }
        if (durationMs < 500) {
          onError("التسجيل قصير جدًا.");
          return;
        }
        setBusy(true);
        try {
          const base64 = await blobToBase64(blob);
          await onReady({
            data: base64,
            mime: normalizeRecorderMime(recorder.mimeType || blob.type),
            ms: Math.min(durationMs, MAX_VOICE_MS),
          });
        } catch {
          onError("تعذّر تجهيز التسجيل.");
        } finally {
          setBusy(false);
        }
      };
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      recorder.start(250);
      setRecording(true);
      setElapsedMs(0);
      timerRef.current = setInterval(() => {
        const elapsed = Date.now() - startedAtRef.current;
        setElapsedMs(elapsed);
        if (elapsed >= MAX_VOICE_MS && recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
        }
      }, 200);
    } catch {
      cleanup();
      onError("تعذّر الوصول إلى الميكروفون — تأكد من إذن المتصفح.");
    }
  }, [busy, cleanup, onError, onReady, recording]);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    }
  }, []);

  const cancel = useCallback(() => {
    cancelRef.current = true;
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
    } else {
      cleanup();
    }
  }, [cleanup]);

  return { recording, elapsedMs, busy, start, stop, cancel };
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read failed"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

/** نوع تسجيل MediaRecorder قد يحمل لواحق الترميز — يُطوَّع لنوع MIME نظيف. */
function normalizeRecorderMime(mime: string): string {
  const stem = mime.trim().toLowerCase().split(";")[0];
  return stem || "audio/webm";
}

/** فقاعة رسالة صوتية: مشغّل المتصفح نفسه بلا إعادة اختراع عجلة التشغيل. */
function VoiceBubble({ id, ms, mine }: {
  id: number; ms: number | null; mine: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <audio
        controls
        preload="metadata"
        src={`/api/messages/voice/${id}`}
        className="h-10 max-w-[220px] sm:max-w-[260px]"
        title="رسالة صوتية"
      />
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black tabular-nums ${
        mine ? "bg-white/25 text-white" : "bg-navy-50 text-navy-800"
      }`} dir="ltr">
        {formatVoiceDuration(ms ?? 0)}
      </span>
    </div>
  );
}

/**
 * فقاعة مرفق: الصورة تُعرض في الفقاعة نفسها، والمستند بطاقة تنزيل.
 *
 * الملف يُجلب من مساره المحروس بعد التحقق من طرفيّة من يطلب — والصورة تُعرض
 * inline والمستند (PDF) يُنزّل: المرفق الطبي وثيقة تُحفظ لا شيء يُتصفح.
 */
function FileBubble({ id, name, mime, size, mine }: {
  id: number; name: string | null; mime: string | null;
  size: number | null; mine: boolean;
}) {
  const isImage = (mime ?? "").startsWith("image/");
  const href = `/api/messages/file/${id}`;
  const label = name ?? "مرفق";
  if (isImage) {
    return (
      <div className="space-y-1.5">
        <a href={href} target="_blank" rel="noopener" title={label}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={href}
            alt={label}
            loading="lazy"
            className="max-h-64 w-auto max-w-full rounded-xl border border-black/5 object-contain"
          />
        </a>
        <a href={href} target="_blank" rel="noopener"
          className={`block text-[10px] font-bold underline ${mine ? "text-white/80" : "text-slate-500"}`}>
          {label}{size ? ` · ${formatFileSize(size)}` : ""}
        </a>
      </div>
    );
  }
  return (
    <a
      href={href}
      download={label}
      className={`flex items-center gap-3 rounded-xl p-2.5 transition-colors ${
        mine ? "bg-white/10 hover:bg-white/20" : "bg-slate-50 hover:bg-slate-100"
      }`}
    >
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
        mine ? "bg-white/15 text-white" : "bg-navy-100 text-navy-800"
      }`}>
        <Icon name="file" className="h-5 w-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-xs font-black ${mine ? "text-white" : "text-navy-900"}`}>
          {label}
        </span>
        <span className={`block text-[10px] font-semibold ${mine ? "text-white/70" : "text-slate-400"}`}>
          مستند{size ? ` · ${formatFileSize(size)}` : ""} · انقر للتنزيل
        </span>
      </span>
      <Icon name="download" className={`h-4 w-4 shrink-0 ${mine ? "text-white/70" : "text-slate-400"}`} />
    </a>
  );
}

/** فقاعة رسالة واحدة — نصية أو صوتية أو مرفقًا، لي أو لطرفي. */
export function MessageBubble({ message, mine }: { message: ChatMessage; mine: boolean }) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 shadow-xs sm:max-w-[70%] ${
        mine
          ? "rounded-br-md bg-navy-800 text-white"
          : "rounded-bl-md border border-slate-200 bg-white text-navy-900"
      }`}>
        {message.kind === "voice" ? (
          <VoiceBubble id={message.id} ms={message.voiceMs} mine={mine} />
        ) : message.kind === "file" ? (
          <FileBubble
            id={message.id}
            name={message.fileName}
            mime={message.fileMime}
            size={message.fileSize}
            mine={mine}
          />
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.body}</p>
        )}
        {message.body && message.kind !== "text" && (
          <p className={`mt-1.5 text-xs leading-relaxed ${mine ? "text-white/90" : "text-slate-600"}`}>
            {message.body}
          </p>
        )}
        <p className={`mt-1 text-[10px] font-semibold tabular-nums ${
          mine ? "text-white/70" : "text-slate-400"
        }`}>
          {messageTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}

/** أزرار شريط الإدخال في وضع التسجيل. */
function RecordingBar({ elapsedMs, busy, onStop, onCancel }: {
  elapsedMs: number; busy: boolean; onStop: () => void; onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-danger-200 bg-danger-50 px-3 py-2">
      <span className="relative flex h-3 w-3 shrink-0" aria-hidden="true">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger-400 opacity-75" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-danger-500" />
      </span>
      <span className="flex-1 text-sm font-black tabular-nums text-danger-800" dir="ltr">
        {formatVoiceDuration(elapsedMs)}
      </span>
      <span className="hidden text-xs font-bold text-danger-700 sm:inline">جارٍ التسجيل…</span>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label="إلغاء التسجيل"
        className="rounded-xl border border-slate-200 bg-white p-2 text-slate-500 hover:text-danger-700 disabled:opacity-50"
      >
        <Icon name="close" className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onStop}
        disabled={busy}
        aria-label="إرسال التسجيل"
        className="rounded-xl bg-navy-800 p-2 text-white hover:bg-navy-900 disabled:opacity-50"
      >
        <Icon name="check" className="h-4 w-4" />
      </button>
    </div>
  );
}

/** شريحة المرفق المختار قبل الإرسال: الاسم والحجم وزر الإزالة. */
function AttachmentChip({ name, size, onRemove }: {
  name: string; size: number; onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-navy-200 bg-navy-50 p-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-navy-800 shadow-xs">
        <Icon name="file" className="h-4.5 w-4.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-black text-navy-900">{name}</p>
        <p className="text-[10px] font-semibold text-slate-500" dir="ltr">{formatFileSize(size)}</p>
      </div>
      <button
        type="button"
        onClick={onRemove}
        aria-label="إزالة المرفق"
        className="shrink-0 rounded-lg p-1.5 text-slate-400 hover:bg-white hover:text-danger-700"
      >
        <Icon name="close" className="h-4 w-4" />
      </button>
    </div>
  );
}

/**
 * شريط إرسال الرسائل — نص بالكتابة، أو صوت بالتسجيل، أو مرفقًا بالاختيار.
 *
 * Enter يرسل وShift+Enter ينزل سطرًا (كما يفعل كل من يكتب كثيرًا)، وزر
 * الميكروفون يتحول إلى شريط تسجيل حي بمؤشر نابض وعداد، وزر المشبك يفتح
 * اختيار صورة أو PDF (حتى 10 ميغابايت — ما فوقه يُرفض في المتصفح قبل الرفع).
 */
export function ChatComposer({ onSendText, onSendVoice, onSendFile, disabled, placeholder }: {
  onSendText: (body: string) => Promise<void>;
  onSendVoice: (voice: { data: string; mime: string; ms: number }) => Promise<void>;
  onSendFile: (file: { name: string; mime: string; size: number; data: string; caption: string | null }) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState<{
    name: string; mime: string; size: number; data: string;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const recorder = useVoiceRecorder(onSendVoice, (message) => setError(message));

  const submitText = async () => {
    const body = text.trim();
    if (sending || recorder.recording || recorder.busy) return;
    if (attachment) {
      await submitAttachment(body || null);
      return;
    }
    if (!body) return;
    setSending(true);
    setError(null);
    try {
      await onSendText(body);
      setText("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "تعذّر الإرسال.");
    } finally {
      setSending(false);
    }
  };

  const submitAttachment = async (caption: string | null) => {
    if (!attachment || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSendFile({
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        data: attachment.data,
        caption,
      });
      setAttachment(null);
      setText("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "تعذّر إرسال المرفق.");
    } finally {
      setSending(false);
    }
  };

  const pickFile = async (file: File | null | undefined) => {
    if (!file) return;
    setError(null);
    if (file.size > MAX_FILE_BYTES) {
      setError(`الملف أكبر من الحد المسموح (10 ميغابايت): ${formatFileSize(file.size)}`);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("read failed"));
        reader.onload = () => {
          const result = String(reader.result ?? "");
          const comma = result.indexOf(",");
          resolve(comma >= 0 ? result.slice(comma + 1) : result);
        };
        reader.readAsDataURL(file);
      });
      setAttachment({ name: file.name, mime: file.type || "application/octet-stream", size: file.size, data });
    } catch {
      setError("تعذّر قراءة الملف.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  if (recorder.recording) {
    return (
      <div className="space-y-2">
        <RecordingBar
          elapsedMs={recorder.elapsedMs}
          busy={recorder.busy}
          onStop={recorder.stop}
          onCancel={recorder.cancel}
        />
        <p className="text-center text-[10px] font-semibold text-slate-400">
          الحد الأقصى دقيقتان — يتوقف التسجيل تلقائيًا عندها.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {error && (
        <p className="rounded-xl border border-danger-200 bg-danger-50 px-3 py-2 text-xs font-bold text-danger-800" role="alert">
          {error}
        </p>
      )}
      {attachment && (
        <AttachmentChip
          name={attachment.name}
          size={attachment.size}
          onRemove={() => setAttachment(null)}
        />
      )}
      <div className="flex items-end gap-2">
        <button
          type="button"
          onClick={() => { setError(null); void recorder.start(); }}
          disabled={disabled || sending || recorder.busy || Boolean(attachment)}
          aria-label="تسجيل رسالة صوتية"
          title="تسجيل رسالة صوتية"
          className="shrink-0 rounded-xl border border-slate-200 bg-white p-2.5 text-navy-800 transition-colors hover:border-navy-300 hover:bg-navy-50 disabled:opacity-50"
        >
          <Icon name="mic" className="h-5 w-5" />
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || sending || recorder.busy}
          aria-label="إرفاق صورة أو مستند"
          title="إرفاق صورة أو مستند (حتى 10 ميغابايت)"
          className="shrink-0 rounded-xl border border-slate-200 bg-white p-2.5 text-navy-800 transition-colors hover:border-navy-300 hover:bg-navy-50 disabled:opacity-50"
        >
          <Icon name="attach" className="h-5 w-5" />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
          onChange={(event) => { void pickFile(event.target.files?.[0]); }}
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
        />
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submitText();
            }
          }}
          rows={1}
          disabled={disabled || sending}
          placeholder={attachment ? "وصف للمرفق (اختياري)…" : placeholder ?? "اكتب رسالتك… (Enter للإرسال)"}
          className="min-h-[44px] max-h-32 flex-1 resize-y rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-navy-900 placeholder:text-slate-400 focus:border-navy-400 focus:outline-none disabled:opacity-50"
          aria-label="نص الرسالة"
        />
        <button
          type="button"
          onClick={() => void submitText()}
          disabled={disabled || sending || recorder.busy || (!text.trim() && !attachment)}
          aria-label="إرسال"
          className="shrink-0 rounded-xl bg-navy-800 p-2.5 text-white transition-colors hover:bg-navy-900 disabled:opacity-50"
        >
          <Icon name="send" className="h-5 w-5" />
        </button>
      </div>
      {recorder.busy && <p className="text-center text-xs font-bold text-slate-400">جارٍ تجهيز التسجيل…</p>}
    </div>
  );
}

/** معاينة سطر المحادثة في القائمة الجانبية. */
export function conversationPreview(
  kind: "text" | "voice" | "file" | null,
  body: string | null,
  voiceMs: number | null,
  fileName?: string | null,
): string {
  if (!kind) return "لا رسائل بعد — ابدأ المحادثة";
  return messagePreview(kind, body, voiceMs, fileName);
}

/** وقت آخر رسالة في القائمة: الوقت اليوم، والتاريخ قبل ذلك. */
export function conversationTime(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  if (sameDay) return messageTime(iso);
  return date.toLocaleDateString("ar-YE", { day: "numeric", month: "short" });
}

/**
 * عامل الخدمة — أقل ما يجعل التثبيت حقيقيًا، ولا أكثر مما يفسد صدق الأرقام.
 *
 * القاعدة الحاكمة: **لا تُخزَّن استجابة API أبدًا**. النظام يعرض صندوقًا وانتظارًا
 * وأرصدة — نسخة قديمة من رقمٍ عرضت بعد تعطل الشبكة أخطر من شاشة خطأ صادقة.
 *
 * فماذا يفعل؟ يخزّن الأغلفة الساكنة (خطوط وأيقونات وCSS/JS المبني) بنسخة جديدة
 * عند كل نشر (`CACHE_VERSION`)، ويعيد مسارات التنقل للشبكة أولًا، وعند فتكة
 * الشبكة يعرض صفحة «أنت غير متصل» بدل خطأ المتصفح الأعمى — فيعرف الطاقم أن
 * ما يُقرأ على الشاشة حيّ أو غائب، لا أنصاف أرقام.
 */

const CACHE_VERSION = "aqlan-shell-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll([OFFLINE_URL])),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // بيانات النظام حيّة أو غائبة — لا نسخة قديمة تُعرض أبدًا.
  if (url.pathname.startsWith("/api/")) return;

  // صفحة غير متصل: نسخة مخزّنة وحدها.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() =>
        caches.match(OFFLINE_URL).then((cached) => cached ?? new Response("غير متصل", { status: 503 })),
      ),
    );
    return;
  }

  // الأغلفة الساكنة: الشبكة أولًا وتُحدَّث النسخة، والاحتياط عند الفتكة.
  if (url.origin === self.location.origin && /\.(css|js|woff2?|png|svg|ico)$/.test(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request)),
    );
  }
});

# صورة النشر — ثلاث مراحل، لا يخرج منها إلا ما يلزم التشغيل.
#
# لماذا Dockerfile لا كاشف المنصة التلقائي: الكاشف يخمّن إصدار Node وأمر البناء
# ويتغيّر تخمينه بترقية المنصة. وبناءٌ يتغيّر وحده تحت عيادة تعمل ليس بناءً — هذا
# الملف يجعل الصورة نفسها تخرج اليوم وبعد سنة، وعلى جهازي كما على المنصة.

# ── الاعتماديات ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# `npm ci` لا `npm install`: يبني من القفل حرفيًا، فلا تتسلّل ترقية صامتة إلى نشرة
# إنتاج بين ليلة وضحاها.
COPY package.json package-lock.json ./
RUN npm ci

# ── البناء ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ── التشغيل ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# مستخدم غير جذر: ثغرةٌ في التطبيق تصل إلى ما يصل إليه المستخدم الذي يشغّله، فلا
# يُشغَّل بصلاحية الجذر ما يستقبل طلبات من الإنترنت.
RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]

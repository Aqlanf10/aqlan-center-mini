# syntax=docker/dockerfile:1

# Build with the same toolchain as CI and local development
# (node:24 bundles npm 11). Nixpacks pairs nodejs_24 with npm 9, whose
# `npm ci` fails on this lockfile in production mode
# ("Missing: @esbuild/aix-ppc64" — npm/cli#4828).

# ---- Build stage ----
FROM node:24-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Railway passes service variables as build arguments when they are
# declared here. Defaults are format-valid placeholders only — the app
# never queries the database during build; it only parses DATABASE_URL
# while Next.js collects page data.
ARG DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ARG AUTH_SECRET=placeholder-secret-used-only-during-build
ARG DATABASE_SSL=true
ARG NEXT_PUBLIC_APP_NAME=Aqlan Center Mini
ARG NEXT_PUBLIC_APP_TIMEZONE=Asia/Aden
ENV DATABASE_URL=$DATABASE_URL \
    AUTH_SECRET=$AUTH_SECRET \
    DATABASE_SSL=$DATABASE_SSL \
    NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME \
    NEXT_PUBLIC_APP_TIMEZONE=$NEXT_PUBLIC_APP_TIMEZONE

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1

# Full node_modules + .next build output (non-standalone next start).
COPY --from=builder /app ./

EXPOSE 3000
CMD ["npm", "run", "start"]

# Next.js application image (the `app` service in docker-compose.yml).
# Multi-stage build producing Next's "standalone" output so the final
# image only carries what's actually needed to run `node server.js`.

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# DATABASE_URL and BETTER_AUTH_SECRET are required at module-load time by
# src/db/index.ts and src/lib/auth.ts respectively, but `next build` only
# statically analyzes/collects routes — it never queries the DB or signs a
# real session. These placeholders exist only so that import doesn't throw
# during the build; the real values come from the container's environment
# at runtime (see docker-compose.yml / .env.example).
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
ENV BETTER_AUTH_SECRET=placeholder-build-time-secret-overridden-at-runtime
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]

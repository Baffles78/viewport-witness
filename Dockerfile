# IMPORTANT: mainnet payments are disabled by default.
# ENABLE_MAINNET_PAYMENTS=true must only be set after an independent code review.
#
# Multi-stage build for ViewportWitness
# - Stage 1: Build TypeScript
# - Stage 2: Production dependencies only
# - Stage 3: Final runtime image with Playwright Chromium

# ── Stage 1: TypeScript build ────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: Production dependencies ────────────────────────────────────────
FROM node:22-slim AS deps

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 3: Final image with Playwright ─────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# Copy built artifacts and production deps
COPY --chown=pwuser:pwuser --from=builder /app/dist ./dist
COPY --chown=pwuser:pwuser --from=deps /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser package.json ./
COPY --chown=pwuser:pwuser llms.txt ./

# Create data directory owned by the service user
RUN mkdir -p /data/screenshots && chown -R pwuser:pwuser /data

# Drop to non-root
USER pwuser

EXPOSE 3000

ENV NODE_ENV=production \
    DATA_DIR=/data \
    SCREENSHOTS_DIR=/data/screenshots \
    DB_PATH=/data/vw.db \
    PAYMENT_MODE=test \
    ENABLE_MAINNET_PAYMENTS=false \
    LOG_LEVEL=info

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]

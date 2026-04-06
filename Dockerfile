FROM node:20-alpine AS builder

# Install build dependencies for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
COPY native/ ./native/ 2>/dev/null || true
RUN npx tsc

# ---------------------------------------------------------------------------
# Production image
# ---------------------------------------------------------------------------
FROM node:20-alpine

# Install Chromium for headless CDP injection
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    && rm -rf /var/cache/apk/*

# Chromium flags for running in container
ENV CHROME_BIN=/usr/bin/chromium-browser \
    CHROME_PATH=/usr/lib/chromium/ \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# Non-root user
RUN addgroup -S popuser && adduser -S popuser -G popuser
WORKDIR /app

# Copy built artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/native ./native 2>/dev/null || true

# Create config directory
RUN mkdir -p /home/popuser/.config/pop-pay && \
    chown -R popuser:popuser /home/popuser /app

USER popuser

# MCP server listens on stdio by default
ENTRYPOINT ["node", "dist/mcp-server.js"]

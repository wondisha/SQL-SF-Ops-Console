# --- Stage 1: Build ---
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY server/ ./server/
COPY public/ ./public/

RUN npm run build:server

# --- Stage 2: Runtime ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist-server ./dist-server
COPY --from=builder /app/public ./public
RUN mkdir -p /app/logs && chown node:node /app/logs

# Run as non-root user
USER node

EXPOSE 4000
CMD ["node", "dist-server/index.js"]

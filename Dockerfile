# Production runtime for the canonical JavaScript server.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src/ ./src/
COPY public/ ./public/
RUN mkdir -p /app/logs && chown node:node /app/logs

# Run as non-root user
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "require('http').get('http://127.0.0.1:4000/healthz/live', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"
CMD ["node", "src/server.js"]

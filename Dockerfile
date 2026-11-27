FROM node:24-bookworm-slim AS web
WORKDIR /build
COPY instagram-web/frontend/package*.json ./
RUN npm ci
COPY instagram-web/frontend/ ./
RUN npm run build

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
COPY --from=web --chown=node:node /build/dist ./instagram-web/frontend/dist
RUN mkdir -p /app/database/instagram-web-private /app/state /app/logs && chown -R node:node /app
USER node
ENV NODE_ENV=production WEB_HOST=0.0.0.0 PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node","start.js"]

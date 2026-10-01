# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# tini reaps zombies and forwards SIGTERM, so the container stops on `docker stop`
RUN apk add --no-cache tini

COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Never run the server as root.
USER node

# Deliberately does NOT set PRIJSPROFEET_HTTP_PORT: the server falls back to the
# PORT variable that Render, Heroku and Fly inject, then 3000. Pinning a port
# here shadows PORT and the service deploys but never receives traffic.
ENV PRIJSPROFEET_BASE_URL=https://www.prijsprofeet.nl \
    PRIJSPROFEET_TRANSPORT=stdio \
    PRIJSPROFEET_HTTP_HOST=0.0.0.0 \
    PRIJSPROFEET_HTTP_PATH=/mcp \
    PRIJSPROFEET_TIMEOUT_MS=30000 \
    PRIJSPROFEET_MAX_RETRIES=2 \
    PRIJSPROFEET_MAX_RESPONSE_BYTES=250000

# Documentation only; platforms assign their own port and ignore this.
EXPOSE 3000

# Reads the port the same way the server does, so the two cannot drift.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const t=process.env.PRIJSPROFEET_TRANSPORT||'stdio';if(t!=='http')process.exit(0);const p=process.env.PRIJSPROFEET_HTTP_PORT||process.env.PORT||3000;fetch('http://127.0.0.1:'+p+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]

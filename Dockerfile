# Huddle in one container: the canvas, the API, schedules and the A2A endpoint.
# Everything it keeps is in /data/huddle.db; mount a volume there.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci
COPY packages packages
RUN npm run build -w @huddle/web

FROM node:24-slim
ENV NODE_ENV=production \
    HUDDLE_HOST=0.0.0.0 \
    HUDDLE_PORT=7700 \
    HUDDLE_DB=/data/huddle.db
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN npm ci --omit=dev && npm cache clean --force
COPY packages/core/src packages/core/src
COPY packages/server/src packages/server/src
COPY --from=build /app/packages/web/dist packages/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7700
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:7700/.well-known/agent-card.json').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "--no-warnings", "packages/server/src/main.ts"]

# syntax=docker/dockerfile:1

FROM node:22-bookworm AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    libcurl4-openssl-dev \
    libicu-dev \
    pkg-config \
    subversion \
    zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY client/package.json client/package.json
COPY server/package.json server/package.json
RUN npm ci

COPY client client
COPY server server
RUN npm run build \
  && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5274

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libcurl4 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node --from=build /app/package.json /app/package-lock.json ./
COPY --chown=node:node --from=build /app/node_modules node_modules
COPY --chown=node:node --from=build /app/server/package.json server/package.json
COPY --chown=node:node --from=build /app/server/node_modules server/node_modules
COPY --chown=node:node --from=build /app/server/dist server/dist
COPY --chown=node:node --from=build /app/client/package.json client/package.json
COPY --chown=node:node --from=build /app/client/dist client/dist

RUN install -d -o node -g node /app/server/data

USER node

VOLUME ["/app/server/data"]
EXPOSE 5274

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||'5274')+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server/dist/index.js"]

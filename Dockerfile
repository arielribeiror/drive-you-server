# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build

COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src

RUN npm run prisma:generate
RUN npm run build

FROM node:22-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PATH="/opt/rembg/bin:${PATH}"
ENV U2NET_HOME=/app/.u2net

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libgomp1 openssl python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/rembg \
  && /opt/rembg/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/rembg/bin/pip install --no-cache-dir "rembg[cpu,cli]>=2.0,<3.0" \
  && mkdir -p /app/.u2net

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist

EXPOSE 3333

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]

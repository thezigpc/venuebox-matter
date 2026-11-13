# Matter bridge for the Bar Games box. Runs read-only, as non-root; writes only /data and /tmp.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    BG_DATA_DIR=/data
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
# Matter: UDP 5540 (operational, IPv6/IPv4) and mDNS UDP 5353. Needs the host network ("lan").
CMD ["node", "dist/index.js"]

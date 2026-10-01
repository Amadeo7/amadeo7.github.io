ARG NODE_VERSION=20

# ---- build ----
FROM node:${NODE_VERSION}-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:${NODE_VERSION}-alpine
ARG PORT=3000
ENV NODE_ENV=production PORT=${PORT}
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE ${PORT}
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- --header="x-api-key: $API_KEY" http://127.0.0.1:${PORT}/receipts/status >/dev/null || exit 1
CMD ["node", "dist/main"]

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci \
    && npm run build --workspace @tutor-matcher/shared \
    && npm run build --workspace api-gateway \
    && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
CMD ["node", "api-gateway/dist/index.js"]

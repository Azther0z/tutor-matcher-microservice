FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build --workspace @tutor-matcher/shared \
    && npm run build --workspace @tutor-matcher/tutor-service \
    && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
USER node
WORKDIR /app/tutor-service
CMD ["node", "dist/index.js"]

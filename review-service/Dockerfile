FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund \
    && npm run build -w @tutor-matcher/shared \
    && npm run build -w @tutor-matcher/review-service \
    && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/shared/package.json ./shared/package.json
COPY --from=build --chown=node:node /app/shared/runtime-env.js ./shared/runtime-env.js
COPY --from=build --chown=node:node /app/shared/dist ./shared/dist
COPY --from=build --chown=node:node /app/review-service/package.json ./review-service/package.json
COPY --from=build --chown=node:node /app/review-service/dist ./review-service/dist
COPY --from=build --chown=node:node /app/contracts ./contracts
USER node
EXPOSE 4005 50055
CMD ["node", "review-service/dist/index.js"]

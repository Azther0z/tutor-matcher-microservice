FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/package.json
COPY auth-service/package.json auth-service/package.json
COPY api-gateway/package.json api-gateway/package.json
COPY web/package.json web/package.json
COPY tutor-service/package.json tutor-service/package.json
COPY booking-service/package.json booking-service/package.json
COPY wallet-service/package.json wallet-service/package.json
COPY notification-service/package.json notification-service/package.json
RUN npm ci --no-audit --no-fund
COPY . .
ARG WORKSPACE
ARG API_GATEWAY_URL=http://api-gateway:8080
ENV API_GATEWAY_URL=$API_GATEWAY_URL NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @tutor-matcher/shared && npm run build --workspace "$WORKSPACE" --if-present
RUN npm prune --omit=dev
RUN node scripts/image-smoke.mjs "$WORKSPACE"

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ARG WORKSPACE
ENV WORKSPACE=$WORKSPACE
COPY --from=build --chown=node:node /app /app
USER node
CMD ["sh", "-c", "exec npm run start --workspace \"$WORKSPACE\""]

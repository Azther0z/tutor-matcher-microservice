FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY services/auth-service/package.json services/auth-service/package.json
COPY apps/web/package.json apps/web/package.json
COPY services/tutor-service/package.json services/tutor-service/package.json
COPY services/review-service/package.json services/review-service/package.json
COPY services/booking-service/package.json services/booking-service/package.json
COPY services/wallet-service/package.json services/wallet-service/package.json
COPY services/notification-service/package.json services/notification-service/package.json
COPY services/messaging-service/package.json services/messaging-service/package.json
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

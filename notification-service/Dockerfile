FROM node:22-alpine AS build
WORKDIR /app/notification-service
COPY notification-service/package*.json ./
RUN npm ci
COPY notification-service/tsconfig.json notification-service/tsconfig.build.json ./
COPY notification-service/src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app/notification-service
ENV NODE_ENV=production CONTRACTS_DIR=/app/contracts
COPY notification-service/package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/notification-service/dist ./dist
COPY contracts/schemas /app/contracts/schemas
COPY contracts/grpc /app/contracts/grpc
USER node
CMD ["node", "dist/index.js"]

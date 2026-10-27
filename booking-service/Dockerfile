FROM node:22-alpine
WORKDIR /app
COPY booking-service/package*.json ./
RUN npm ci --omit=dev
COPY booking-service/src ./src
COPY shared /shared
COPY proto /proto
CMD ["node", "src/index.js"]

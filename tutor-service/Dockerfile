FROM node:22-alpine
WORKDIR /app
COPY tutor-service/package*.json ./
RUN npm ci --omit=dev
COPY tutor-service/src ./src
COPY shared /shared
COPY proto /proto
CMD ["node", "src/index.js"]

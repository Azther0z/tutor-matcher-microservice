FROM node:22-alpine
WORKDIR /app
COPY notification-service/package*.json ./
RUN npm ci --omit=dev
COPY notification-service/src ./src
CMD ["node", "src/index.js"]

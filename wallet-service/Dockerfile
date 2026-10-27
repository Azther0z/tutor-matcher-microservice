FROM node:22-alpine
WORKDIR /app
COPY wallet-service/package*.json ./
RUN npm ci --omit=dev
COPY wallet-service/src ./src
COPY shared /shared
CMD ["node", "src/index.js"]

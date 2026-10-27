FROM node:22-alpine
WORKDIR /app
COPY auth-service/package*.json ./
RUN npm ci --omit=dev
COPY auth-service/src ./src
COPY shared /shared
CMD ["node", "src/index.js"]

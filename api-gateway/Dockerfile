FROM node:22-alpine
WORKDIR /app
COPY api-gateway/package*.json ./
RUN npm ci --omit=dev
COPY api-gateway/src ./src
CMD ["node", "src/index.js"]

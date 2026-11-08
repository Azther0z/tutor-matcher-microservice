FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci \
    && npm run build --workspace @tutor-matcher/shared \
    && npm run build --workspace auth-service \
    && npm prune --omit=dev
WORKDIR /app/auth-service
CMD ["node", "dist/index.js"]

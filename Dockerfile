FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production TZ=Asia/Seoul
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# 마이그레이션 SQL이 없으면 시작할 때 migrate()가 실패한다.
COPY drizzle ./drizzle
CMD ["node", "dist/index.js"]

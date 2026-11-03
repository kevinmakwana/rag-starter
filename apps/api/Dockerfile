# syntax=docker/dockerfile:1
# Build from the repository root: docker build -f apps/api/Dockerfile .

FROM node:22-slim AS build
WORKDIR /app
# npm validates the lockfile against every workspace, so both manifests are needed even for one app.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
COPY apps/api/src apps/api/src
RUN npm run build -w apps/api

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/api --omit=dev && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production
# The API resolves ../../.env and ../../samples from its working directory, so keep the repository layout.
COPY --from=deps /app /app
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY samples /app/samples
WORKDIR /app/apps/api
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

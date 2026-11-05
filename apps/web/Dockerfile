# Build from the repository root: docker build -f apps/web/Dockerfile .

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web
COPY apps/web apps/web
# Next.js inlines NEXT_PUBLIC_* into the browser bundle at build time, so the API address is fixed per image.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/web

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci -w apps/web --omit=dev && npm cache clean --force

FROM node:22-slim
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app /app
COPY --from=build /app/apps/web/.next /app/apps/web/.next
COPY apps/web/next.config.mjs /app/apps/web/next.config.mjs
WORKDIR /app/apps/web
USER node
EXPOSE 3000
CMD ["node", "../../node_modules/next/dist/bin/next", "start", "-p", "3000"]

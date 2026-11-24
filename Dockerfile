FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY public ./public
# The shop's data (SQLite, print files) will live on a volume mounted here.
RUN mkdir -p /var/lib/shop && chown 1000:1000 /var/lib/shop
# Numeric, not `USER node`: runAsNonRoot must be able to verify it.
USER 1000:1000
# Stamped by the deploy (YYYY.MM.DD.N); "dev" for local builds. Last, so a new
# version does not invalidate the dependency layers above.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
EXPOSE 8080
CMD ["node", "dist/src/server.js"]

FROM node:24-alpine AS builder

RUN apk add --no-cache git

WORKDIR /app
COPY . .
RUN npm ci && npm run build

FROM node:24-alpine

RUN apk add --no-cache git

WORKDIR /app
COPY --from=builder /app/dist/index.mjs ./

ENV PORT=3000
ENV SNIPPET_REPOSITORIES_PATH=/repositories
ENV GIT_CONFIG_COUNT=1
ENV GIT_CONFIG_KEY_0=safe.directory
ENV GIT_CONFIG_VALUE_0=*

EXPOSE 3000
CMD ["node", "index.mjs"]

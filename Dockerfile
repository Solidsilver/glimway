# syntax=docker/dockerfile:1
# Static assets are architecture independent; build them on the builder's CPU.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS web
WORKDIR /build
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html vite.config.ts svelte.config.js tsconfig.json ./
COPY scripts/build-version.mjs ./scripts/
COPY src ./src
COPY public ./public
COPY content ./content
# Fail loudly if the build context still contains Git LFS pointers.
RUN if grep -rl '^version https://git-lfs.github.com/spec/v1$' public; then \
      echo 'Run git lfs pull before building: runtime art contains LFS pointers.' >&2; exit 1; \
    fi
ARG VITE_HABITICA_CREATOR_ID=5abfd539-22eb-457f-8e2a-9fb3d66731f1
ARG VITE_HABITICA_APP_NAME=glimway
ENV VITE_HABITICA_CREATOR_ID=$VITE_HABITICA_CREATOR_ID \
    VITE_HABITICA_APP_NAME=$VITE_HABITICA_APP_NAME
# The build id (the release workflow passes the commit). Empty: the build
# hashes its sources, since the context has no .git (scripts/build-version.mjs).
ARG GLIMWAY_BUILD=
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26-alpine@sha256:8ac98ca534ac3f51e1f420a1dd2c15e74c75cfa0f23f3ad27eb5d7236c349a0c AS server
WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY server ./server
COPY content ./content
COPY package.json ./
ARG TARGETOS=linux
ARG TARGETARCH
ARG GLIMWAY_BUILD=
# modernc.org/sqlite is pure Go; both supported architectures need no CGO.
# The version is package.json's; a full commit hash is shortened to seven.
RUN version=$(sed -n 's/^  "version": "\([0-9]*\.[0-9]*\.[0-9]*\)",$/\1/p' package.json) \
    && test -n "$version" \
    && build=$GLIMWAY_BUILD \
    && if echo "$build" | grep -Eq '^[0-9a-f]{40}$'; then build=$(printf %.7s "$build"); fi \
    && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=$version -X main.build=$build" -o /out/glimway-server ./server/cmd/glimway-server

FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
RUN apk add --no-cache ca-certificates \
    && addgroup -g 10001 glimway \
    && adduser -D -u 10001 -G glimway -h /data glimway \
    && mkdir -p /data \
    && chown glimway:glimway /data \
    && chmod 0700 /data
COPY --from=server /out/glimway-server /usr/local/bin/glimway-server
COPY --from=web /build/dist /web
LABEL org.opencontainers.image.source="https://github.com/Solidsilver/glimway" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"
ENV GLIMWAY_LISTEN=0.0.0.0:8090 \
    GLIMWAY_DB=/data/glimway.sqlite \
    GLIMWAY_STATIC_DIR=/web \
    GLIMWAY_SPRITE_CACHE=/data/habitica-sprites \
    GLIMWAY_COOKIE_SECURE=true \
    GLIMWAY_HEALTHCHECK_URL=http://127.0.0.1:8090/api/health
USER 10001:10001
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -q -O /dev/null "$GLIMWAY_HEALTHCHECK_URL" || exit 1
ENTRYPOINT ["/usr/local/bin/glimway-server"]

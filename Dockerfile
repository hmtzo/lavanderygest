# Lavandery Inspeção — single-image deploy
FROM node:20-alpine AS base
WORKDIR /app

# Install server deps (better-sqlite3 needs build tools)
FROM base AS deps
RUN apk add --no-cache python3 make g++ libc-dev
COPY server/package.json server/package-lock.json* ./server/
WORKDIR /app/server
RUN npm install --production --no-audit --no-fund

FROM base AS runtime
RUN apk add --no-cache tini
ENV NODE_ENV=production
# Copy server + static files
COPY --from=deps /app/server/node_modules /app/server/node_modules
COPY server /app/server
# server/repasse.js já incluso em COPY server
COPY app.js /app/app.js
COPY bubbles.js /app/bubbles.js
COPY admin.html /app/admin.html
COPY chamado.html /app/chamado.html
COPY condo-login.html /app/condo-login.html
COPY condo.html /app/condo.html
COPY implantacao.html /app/implantacao.html
COPY index.html /app/index.html
COPY login.html /app/login.html
COPY financeiro.html /app/financeiro.html
COPY styles.css /app/styles.css
COPY design.css /app/design.css
COPY logo.svg /app/logo.svg
COPY README.md /app/README.md
# Persist DB on /data volume
ENV LAVANDERY_DB=/data/lavandery.db
RUN mkdir -p /data
VOLUME /data
EXPOSE 3000
WORKDIR /app/server
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O /dev/null http://localhost:3000/health || exit 1
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","index.js"]

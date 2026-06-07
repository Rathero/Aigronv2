# =============================================================================
# Dockerfile — imagen de producción del backend de AIGRONS (sirve también el
# frontend en /). Contexto de build: la RAÍZ del repo (necesita server/ y web/).
# =============================================================================
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Instala solo dependencias de producción (capa cacheable).
COPY server/package.json ./server/package.json
RUN cd server && npm install --omit=dev --no-audit --no-fund

# Código de la app + frontend + motor compartido.
COPY server ./server
COPY web ./web

WORKDIR /app/server
EXPOSE 3000

# Healthcheck contra el endpoint /health.
HEALTHCHECK --interval=30s --timeout=4s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migra el esquema (idempotente) y arranca la API.
CMD ["sh", "-c", "node scripts/migrate.js && node src/app.js"]

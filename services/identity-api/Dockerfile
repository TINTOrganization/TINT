# ── Etapa 1: compilación TypeScript ────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

# ── Etapa 2: dependencias de producción únicamente ─────────────────────────
FROM node:22-alpine AS deps-prod
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Etapa 3: imagen final (sin fuentes TS ni devDependencies de desarrollo) ─
FROM node:22-alpine
WORKDIR /app
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=build /app/node_modules/drizzle-kit ./node_modules/drizzle-kit
COPY --from=build /app/node_modules/.bin/drizzle-kit ./node_modules/.bin/drizzle-kit
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts
COPY package*.json ./
ENV NODE_ENV=production
EXPOSE 8081
HEALTHCHECK --interval=10s --timeout=5s \
  CMD node -e "fetch('http://localhost:8081/api/v1/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["sh", "-c", "npm run migrate && npm start"]

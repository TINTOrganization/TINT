FROM node:22-alpine AS build

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_IDENTITY_API_URL=/api/v1
ARG VITE_SYNC_WS_URL=/ws/sync
ARG VITE_SOCIAL_WS_URL=/ws/social
ARG VITE_VOICE_WS_URL=/ws/voice
ARG VITE_ANALYTICS_API_URL=/api/v1
ARG VITE_SYNC_ENCODING=json
# Vacío = mismo origen: la imagen la sirve el gateway, que enruta /api/v1/stream/* a stream-core.
ARG VITE_STREAM_API_URL=
ARG VITE_FIREBASE_API_KEY=test
ARG VITE_FIREBASE_AUTH_DOMAIN=test
ARG VITE_FIREBASE_PROJECT_ID=test
# Solo desarrollo (ADR 0024): origen del Firebase Auth Emulator. Vacío = Firebase real.
ARG VITE_FIREBASE_AUTH_EMULATOR_URL=
ENV VITE_IDENTITY_API_URL=$VITE_IDENTITY_API_URL \
    VITE_SYNC_WS_URL=$VITE_SYNC_WS_URL \
    VITE_SOCIAL_WS_URL=$VITE_SOCIAL_WS_URL \
    VITE_VOICE_WS_URL=$VITE_VOICE_WS_URL \
    VITE_ANALYTICS_API_URL=$VITE_ANALYTICS_API_URL \
    VITE_SYNC_ENCODING=$VITE_SYNC_ENCODING \
    VITE_STREAM_API_URL=$VITE_STREAM_API_URL \
    VITE_FIREBASE_API_KEY=$VITE_FIREBASE_API_KEY \
    VITE_FIREBASE_AUTH_DOMAIN=$VITE_FIREBASE_AUTH_DOMAIN \
    VITE_FIREBASE_PROJECT_ID=$VITE_FIREBASE_PROJECT_ID \
    VITE_FIREBASE_AUTH_EMULATOR_URL=$VITE_FIREBASE_AUTH_EMULATOR_URL
RUN npm run build

FROM nginx:1.27-alpine
# Plantilla procesada por el entrypoint oficial: solo se sustituye NGINX_ERROR_LOG_LEVEL,
# para que `$uri`, `$host` y el resto de variables de nginx lleguen intactas (ADR 0021).
ENV NGINX_ENVSUBST_FILTER=NGINX_ERROR_LOG_LEVEL
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget --spider --quiet http://127.0.0.1/healthz || exit 1

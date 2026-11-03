# Firebase Auth Emulator para el login local del host (solo desarrollo, ADR 0024).
# Emite ID tokens SIN firma (alg: none): nunca se despliega en producción.
# El emulador de Auth es Node puro (no necesita Java).
FROM node:22-alpine

# Versión exacta de firebase-tools (publicada el 2026-10-14).
ARG FIREBASE_TOOLS_VERSION=15.34.0
RUN npm install --global --no-audit --no-fund "firebase-tools@${FIREBASE_TOOLS_VERSION}" \
    && npm cache clean --force

USER node
WORKDIR /home/node/emulator
COPY --chown=node:node firebase.json ./

# Sin avisos de actualización ni preguntas interactivas (telemetría desactivada).
ENV CI=true \
    NO_UPDATE_NOTIFIER=1 \
    FIREBASE_PROJECT_ID=demo-tint

EXPOSE 9099
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD wget --quiet --output-document=- http://127.0.0.1:9099/ | grep -Eq '"ready": *true' || exit 1

# Proyecto demo-*: el emulador no llama a Google. Solo el emulador de Auth.
CMD ["sh", "-c", "case \"$FIREBASE_PROJECT_ID\" in demo-*) ;; *) echo \"FIREBASE_PROJECT_ID debe empezar por demo- (es $FIREBASE_PROJECT_ID)\" >&2; exit 1 ;; esac; exec firebase emulators:start --only auth --project \"$FIREBASE_PROJECT_ID\""]

FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY migrations ./migrations
RUN npm run build

ENV NODE_ENV=production
EXPOSE 8081
CMD ["sh", "-c", "npm run migrate && npm start"]

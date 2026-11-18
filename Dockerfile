# Runs the same way on any host (Render, Railway, Fly.io, a VPS, AWS, GCP). Build: docker build -t stampwise .
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
USER node
EXPOSE 3000
# migrations are idempotent and locked, so running them on every start is safe
CMD ["sh","-c","node migrate.js && node server.js"]

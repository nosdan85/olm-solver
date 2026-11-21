FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium fonts-freefont-ttf \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    PORT=3000

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --chown=node:node . .
RUN install -d -o node -g node /app/data
USER node

EXPOSE 3000
CMD ["node", "server.js"]

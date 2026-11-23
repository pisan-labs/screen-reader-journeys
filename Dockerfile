# The hosted service (docs/deploy.md): the HTTP API and the worker in one process, with Chromium
# from the official Playwright image. Keep the tag in step with package.json's playwright version
# (1.63.0), or Playwright will not find its browsers.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=10000
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY server ./server
COPY targets ./targets

# The image's unprivileged user. Reports are written to the temp directory and deleted after upload.
USER pwuser
EXPOSE 10000
CMD ["node", "server/index.js"]

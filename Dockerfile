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

# The server starts as root only so that it can start each run as "runner", an unprivileged user
# with no access to the server's environment (and so its Supabase keys), even if a tested page
# breaks out of Chromium. Reports are written to a temp folder and deleted after upload.
RUN groupadd --system --gid 10001 runner \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin runner
ENV RUN_AS_UID=10001 \
    RUN_AS_GID=10001
USER root
EXPOSE 10000
CMD ["node", "server/index.js"]

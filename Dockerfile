# The hosted service (docs/deploy.md): the HTTP API and the worker in one process, with Chromium
# from the official Playwright image. Keep the tag in step with package.json's playwright version
# (1.63.0), or Playwright will not find its browsers.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    PORT=10000
WORKDIR /app

# tini as PID 1: it reaps orphaned processes (node does not), so a run's leftovers do not pile up
# as zombies, and the worker's stop (server/reports.js) can tell them from live processes. -s makes
# it a subreaper too, so it still reaps them if the host puts another init in front of it. When
# the server exits, tini exits and the whole container stops, which the worker relies on when a
# run's processes will not stop.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY server ./server
COPY targets ./targets

# The server starts as root only so that it can start each run as "runner", an unprivileged user
# with no access to the server's environment (and so WORKER_TOKEN), even if a tested page breaks
# out of Chromium. Reports are written to a temp folder and deleted once they are saved.
RUN groupadd --system --gid 10001 runner \
 && useradd --system --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin runner
ENV RUN_AS_UID=10001 \
    RUN_AS_GID=10001
USER root
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["node", "server/index.js"]

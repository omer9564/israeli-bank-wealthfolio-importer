FROM oven/bun:1.4.0-debian

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Jerusalem \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Chromium is installed at build time so no scheduled run pays a browser download.
# fonts-noto-hebrew was dropped by Debian trixie; fonts-noto-core is the successor
# package and still ships NotoSansHebrew/NotoSerifHebrew/NotoRashiHebrew.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium fonts-liberation fonts-noto-color-emoji fonts-noto-core \
      ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/scraper/package.json packages/scraper/
COPY apps/cli/package.json apps/cli/
RUN bun install --frozen-lockfile --production

COPY packages packages
COPY apps apps
COPY tsconfig.json ./

# Bank credentials pass through this process; it has no reason to be root.
RUN useradd --create-home --shell /usr/sbin/nologin importer \
 && chown -R importer:importer /app
USER importer

# Absolute path: GitHub Actions runs Docker container actions with the working
# directory forced to GITHUB_WORKSPACE (the consumer's checkout, not /app), so a
# path relative to WORKDIR would fail to resolve on every invocation as an Action.
# https://docs.github.com/en/actions/sharing-automations/creating-actions/dockerfile-support-for-github-actions
ENTRYPOINT ["bun", "/app/apps/cli/src/index.ts"]
CMD ["sync"]

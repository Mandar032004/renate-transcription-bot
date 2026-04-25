# Per-session bot container: Playwright + PulseAudio + FFmpeg.
# Spawned by the worker via `docker run`; exits at call end.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# PulseAudio socket path is set by the entrypoint after the daemon boots.

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        pulseaudio \
        pulseaudio-utils \
        ffmpeg \
        dbus-x11 \
        xvfb \
        x11-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install workspace deps: we build from the repo root so the bot has access
# to the shared lockfile via npm workspaces.
COPY package.json package-lock.json* ./
COPY bot/package.json ./bot/
RUN npm install --workspace @renate/bot --include-workspace-root

COPY bot ./bot
# Normalize Windows CRLF line endings so /usr/bin/env bash in entrypoint.sh
# doesn't fail with `'bash\r': No such file or directory` when the repo was
# checked out on Windows with core.autocrlf=true.
RUN sed -i 's/\r$//' ./bot/docker/entrypoint.sh \
    && npm run build --workspace @renate/bot \
    && chmod +x ./bot/docker/entrypoint.sh \
    && mkdir -p /chunks

ENV NODE_ENV=production
WORKDIR /app/bot
ENTRYPOINT ["/app/bot/docker/entrypoint.sh"]
CMD ["node", "dist/src/index.js"]

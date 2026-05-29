FROM oven/bun:1-alpine

# The dashboard talks to GitHub over native fetch (api.github.com), so no gh
# CLI is needed at runtime — just TLS roots and tini as PID 1 for signals.
# Alpine has no bash, so entrypoint.sh is plain POSIX sh.
RUN apk add --no-cache ca-certificates tini

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DASHBOARD_PORT=3456
ENV DASHBOARD_HOST=0.0.0.0

ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]

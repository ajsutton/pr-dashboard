FROM oven/bun:1-slim

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV DASHBOARD_PORT=3456
ENV DASHBOARD_HOST=0.0.0.0

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS base
RUN npm install --global pnpm@10.32.1
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY test ./test
COPY biome.json ./
COPY scripts ./scripts
COPY accounts.example.json .env.example ./
RUN pnpm build

FROM build AS test
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN pnpm exec playwright install --with-deps chromium && chown -R node:node /app
COPY .gitignore ./
USER node
CMD ["pnpm", "check"]

FROM base AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    WG_MCP_DATA_DIR=/data \
    WG_MCP_CONFIG=/config/accounts.json \
    WG_MCP_READ_ONLY=true \
    WG_MCP_HEADLESS=true \
    WG_MCP_BROWSER_CHANNEL=chromium
COPY package.json pnpm-lock.yaml .npmrc ./
RUN pnpm install --prod --frozen-lockfile \
    && pnpm exec playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /config /attachments \
    && chown node:node /data /config /attachments
COPY --from=build /app/dist ./dist
COPY accounts.example.json .env.example ./
COPY LICENSE ./
USER node
ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "--transport", "stdio"]

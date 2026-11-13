# mcp-planka: stdio MCP server for Planka v2.
# Run (config is mounted, never baked in):
#   docker run -i --rm -v /path/.planka:/app/.planka:ro -v mcp-planka-state:/data mcp-planka
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PLANKA_CONFIG=/app/.planka \
    PLANKA_STATE_DIR=/data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
VOLUME /data
ENTRYPOINT ["node", "dist/index.js"]

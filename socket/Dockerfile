FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Build from the repository root so the frontend is available beside socket/.
COPY socket/package.json socket/package-lock.json ./socket/
RUN npm ci --prefix socket --omit=dev && npm cache clean --force

COPY --chown=node:node socket/server.js ./socket/server.js
COPY --chown=node:node socket/status.html ./socket/status.html
COPY --chown=node:node index.html hammer.png hammer.wav ./

# Local storage is writable when Firebase is not configured.
RUN chown node:node /app/socket
USER node

EXPOSE 3000
CMD ["node", "socket/server.js"]

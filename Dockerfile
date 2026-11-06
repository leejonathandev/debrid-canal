FROM node:26-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node . .
RUN mkdir -p /app/data && chown node:node /app/data && chmod 700 /app/data

USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]

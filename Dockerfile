FROM node:24-bookworm-slim

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=node:node . .

USER node
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]

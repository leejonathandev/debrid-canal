FROM node:lts

WORKDIR /app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
EXPOSE 3000

CMD ["npm", "start"]

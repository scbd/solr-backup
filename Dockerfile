FROM node:14-alpine

WORKDIR /usr/src/app

COPY package.json ./

ENV NODE_OPTIONS=--max-old-space-size=2848

RUN npm install --only=prod

COPY . ./

CMD [ "node", "src/index.js" ]
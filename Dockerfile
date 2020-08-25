FROM node:12.0-alpine

WORKDIR /usr/src/app

COPY package.json ./

RUN npm install --only=prod

COPY . ./

CMD [ "node", "src/index.js" ]
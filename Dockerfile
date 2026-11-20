FROM node:26-alpine

WORKDIR /usr/src/app

COPY package.json ./

RUN npm install --omit=dev

COPY . ./

CMD [ "node", "src/index.js" ]

FROM node:12.0-alpine

WORKDIR /usr/src/app

COPY package.json ./

RUN npm install --only=prod

COPY . ./

CMD [ "node","--max_old_space_size=2848", "src/index.js" ]
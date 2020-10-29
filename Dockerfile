FROM node:14

WORKDIR /usr/src/app

COPY package.json ./

# ENV NODE_OPTIONS="--max_old_space_size=2848"

RUN npm install --only=prod

COPY . ./

CMD [ "node", "src/index.js" ]
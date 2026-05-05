FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

RUN mkdir -p /data/sessions

EXPOSE 3000

CMD ["npm", "run", "start"]

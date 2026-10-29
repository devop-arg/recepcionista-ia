# syntax=docker/dockerfile:1
FROM node:22-alpine

ENV NODE_ENV=production \
    RECEPCIONISTA_DATOS=/data \
    RECEPCIONISTA_PUERTO=8790

WORKDIR /app

# Sin dependencias de runtime: el lock se instala igual para fijar el árbol vacío.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY vendor ./vendor

RUN mkdir -p /data && chown -R node:node /data
USER node

EXPOSE 8790
VOLUME ["/data"]

CMD ["node", "src/server.js"]

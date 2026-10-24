FROM node:24-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    BASE_PATH=/CuentaClara \
    DATA_DIR=/data

WORKDIR /app

COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]

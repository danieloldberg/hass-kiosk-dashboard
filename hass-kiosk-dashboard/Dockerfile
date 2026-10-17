FROM node:22-alpine3.22

WORKDIR /app
COPY server.cjs index.html style.css app.js ./

ENV NODE_ENV=production \
    HEMMA_INGRESS=1 \
    HEMMA_DATA_DIR=/data \
    PORT=8099

CMD ["node", "server.cjs"]

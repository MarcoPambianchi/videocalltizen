FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 9090
HEALTHCHECK --interval=10s --timeout=3s --retries=10 \
  CMD wget -qO- http://127.0.0.1:9090/healthz || exit 1
CMD ["node", "server.js"]

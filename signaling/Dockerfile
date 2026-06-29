FROM node:20-alpine
# ffmpeg : relais RTSP(go2rtc) -> FLV(ingress). Le muxer RTMP natif de go2rtc produit,
# pour une source poussée, un FLV que le pipeline GStreamer de l'Ingress refuse
# ("could not add bin"). ffmpeg règle ça (cf go2rtcPublish dans server.js).
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY . .
EXPOSE 9090
HEALTHCHECK --interval=10s --timeout=3s --retries=10 \
  CMD wget -qO- http://127.0.0.1:9090/healthz || exit 1
CMD ["node", "server.js"]

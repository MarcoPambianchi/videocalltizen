# C8 — Client web interlocuteur (fork minimal LiveKit Meet).
# Sert des fichiers statiques via nginx ; aucune build, aucun compte.
FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY index.html app.js style.css /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=10 \
  CMD wget -qO- http://127.0.0.1:80/ >/dev/null 2>&1 || exit 1

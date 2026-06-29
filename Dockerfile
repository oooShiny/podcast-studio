FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --production && npm cache clean --force

COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY plugins/ ./plugins/
COPY prep.html ./
COPY settings.html ./

# Data directories are declared as volumes so a named volume or bind-mount
# survives container restarts. The server creates them at startup if absent.
VOLUME ["/app/recordings", "/app/clips", "/app/prep-notes", \
        "/app/prep-sources", "/app/screenshots", "/app/branding"]

EXPOSE 3000

CMD ["node", "server.js"]

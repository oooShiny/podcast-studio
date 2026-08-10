FROM node:20-alpine

ARG GIT_SHA=unknown
ARG GITHUB_REPO=oooShiny/podcast-studio
ENV GIT_SHA=$GIT_SHA
ENV GITHUB_REPO=$GITHUB_REPO

WORKDIR /app

COPY package.json ./
RUN npm install --production && npm cache clean --force
RUN apk add --no-cache ffmpeg

COPY server.js ./
COPY lib/ ./lib/
COPY public/ ./public/
COPY plugins/ ./plugins/

# Data directories are declared as volumes so a named volume or bind-mount
# survives container restarts. The server creates them at startup if absent.
VOLUME ["/app/recordings", "/app/clips", "/app/prep-notes", \
        "/app/prep-sources", "/app/screenshots", "/app/branding"]

EXPOSE 3000

CMD ["node", "server.js"]

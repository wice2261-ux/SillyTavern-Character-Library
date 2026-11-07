FROM ghcr.io/sillytavern/sillytavern:1.18.0
COPY --chown=node:node adapter /opt/st-character-library/adapter
RUN node /opt/st-character-library/adapter/install.mjs apply /home/node/app
COPY --chown=node:node server /home/node/app/plugins/character-library
COPY --chown=node:node extension /home/node/app/public/scripts/extensions/third-party/character-library
COPY --chown=node:node recover.mjs /opt/st-character-library/recover.mjs
COPY --chown=node:node repair-index.mjs /opt/st-character-library/repair-index.mjs
COPY --chown=node:node server /opt/st-character-library/server

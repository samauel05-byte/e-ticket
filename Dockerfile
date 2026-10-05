FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json .npmrc ./
# better-sqlite3 trae binarios precompilados (ver .npmrc): no hace falta compilador
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
ENV DB_PATH=/app/data/eticket.db UPLOAD_DIR=/app/data/uploads PORT=3000
EXPOSE 3000
VOLUME /app/data
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]

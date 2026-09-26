FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY src ./src
COPY public ./public
COPY data ./data
# Split-deploy defaults (compose overrides FRONTEND_URL per env).
ENV PORT=8080 HOST=0.0.0.0 SERVE_STATIC=0 NODE_ENV=production
CMD ["node","src/server.js"]

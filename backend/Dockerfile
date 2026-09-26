# Backend Dockerfile. Build context MUST be the repo root, e.g.:
#   docker build -f backend/Dockerfile -t swaraj-backend .
#   docker run -p 8000:8000 -e PORT=8000 -e HOST=0.0.0.0 -e SERVE_STATIC=0 -e FRONTEND_URL=https://<app>.vercel.app swaraj-backend
FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY src ./src
COPY data ./data
ENV PORT=8000 HOST=0.0.0.0 SERVE_STATIC=0 NODE_ENV=production
EXPOSE 8000
CMD ["node", "src/server.js"]

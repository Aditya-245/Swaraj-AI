FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev || true
COPY src ./src
COPY public ./public
COPY data ./data
CMD ["node","src/server.js"]

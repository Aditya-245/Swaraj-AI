FROM node:20-slim
WORKDIR /app
COPY public ./public
RUN npm i -g serve || true
CMD ["npx","serve","-l","3000","public"]

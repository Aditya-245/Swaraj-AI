# Static serve of the vanilla UI (../public). No build step.
FROM node:20-slim
WORKDIR /app
COPY public ./public
RUN npm i -g serve || true
EXPOSE 3000
CMD ["npx", "serve", "-l", "3000", "public"]

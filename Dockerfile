# QuizBuzz is one small always-on Node process with its SQLite file on a
# mounted volume beside it. Nothing here compiles — SQLite ships inside Node 22
# — so the image is just "copy the built app in and run it".

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

# The server serves the built client from ../client/dist relative to its own
# working directory, and keeps the database on the volume mounted at /data.
WORKDIR /app/server
ENV PORT=8080 DATABASE_FILE=/data/quizbuzz.sqlite
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/index.js"]

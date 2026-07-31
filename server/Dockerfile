# syntax = docker/dockerfile:1

ARG NODE_VERSION=26.4.0
FROM node:${NODE_VERSION}-slim AS base

LABEL fly_launch_runtime="Node.js"

WORKDIR /app
ENV NODE_ENV="production"


# ---- Dependencies ----
FROM base AS build

# No build toolchain required: playkit has no native dependencies. Storage is
# Node's built-in node:sqlite and hashing is node:crypto, so there is nothing
# for node-gyp to compile.
COPY package-lock.json package.json ./
RUN npm ci --omit=dev

COPY . .


# ---- Runtime ----
FROM base
COPY --from=build /app /app

EXPOSE 3000

# Run the TypeScript entry point directly. Node strips types natively — the
# imports carry explicit .ts extensions — so tsx stays a dev-only tool and is
# never needed in the production image. (Running `npm run start` here would
# fail: it calls tsx, which --omit=dev correctly leaves out.)
CMD [ "node", "src/server.ts" ]

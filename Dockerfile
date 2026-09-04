# The sidecar image.
#
# The base is pinned by digest, not by tag. A tag moves, so an image built from
# one is not the image that was reviewed, and "it worked yesterday" stops being
# a statement about anything. Re-resolve the digest deliberately when you
# upgrade, rather than inheriting whatever the tag points at today.
#
# Digest resolved for node:22-alpine on 2026-09-04. Node 22.13 or newer is
# required: the default people store is node:sqlite and the CLI relies on the
# type stripping that release added.
FROM node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build

WORKDIR /build

# The lockfile is copied on its own so a change to the source does not
# reinstall every dependency.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY tools ./tools
RUN npm run build

# Drop everything that only exists to build and test. The runtime image then
# carries no compiler, no test runner and no linter, which is both smaller and
# a smaller thing to have to patch.
RUN npm prune --omit=dev

FROM node@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime

# No secrets are baked in. Every credential arrives at run time through the
# environment or a mounted file, and jml.config.yaml holds references to them
# rather than values, so this image is safe to publish.
ENV NODE_ENV=production
ENV JML_CONFIG=/app/config/jml.config.yaml

WORKDIR /app

COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./
COPY bin ./bin
COPY schema ./schema
COPY n8n ./n8n

# Three volumes, and each one is a different kind of thing: the people store,
# the append-only audit log, and the configuration. They are created here with
# the right ownership so a first run as a non-root user can write to them.
RUN mkdir -p /app/data /app/audit /app/config && chown -R node:node /app/data /app/audit /app/config

# Never root. This process holds every vendor credential the toolkit uses, so
# it runs as the unprivileged user the base image already provides.
USER node

# The port is exposed to the compose network only. The shipped compose file
# deliberately does not publish it to the host: the automation tool reaches
# this service by name, and nothing else can reach it at all.
EXPOSE 8787

# One unauthenticated route, answering one field, which is exactly what a
# health check needs and nothing an attacker can learn anything from.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/jml.mjs"]
CMD ["serve"]

# Roundup on a server (Fly.io): a long-running Node process (Spectrum keeps a gRPC connection to Photon open).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# Dev dependencies too: tsx runs the TypeScript directly, and the Photon CLI registers new numbers.
RUN npm ci --include=dev && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json human_conversations_500.jsonl ./
CMD ["sh", "scripts/start.sh"]

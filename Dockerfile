# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json tsconfig.json ./

# Copy source code
COPY src ./src

# Install all dependencies and build (prepare script runs automatically)
RUN --mount=type=cache,target=/root/.npm,id=npm-cache npm ci --no-audit --no-fund

# Production stage - minimal runtime
FROM node:20-alpine AS production

# OCI labels for better container management
LABEL org.opencontainers.image.title="sentry-selfhosted-mcp"
LABEL org.opencontainers.image.description="MCP server for self-hosted Sentry instances"
LABEL org.opencontainers.image.version="1.0.0"
LABEL org.opencontainers.image.source="https://github.com/HieuAnh87/sentry-selfhosted-mcp"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.vendor="hieuda"

WORKDIR /app

# Create non-root user first (better layer caching)
RUN addgroup -g 1001 -S mcpuser && \
    adduser -S mcpuser -u 1001 -G mcpuser

# Copy package files
COPY package*.json ./

# Install only production dependencies
# --ignore-scripts: skip prepare (build already done)
# --no-audit --no-fund: faster install, less noise
RUN --mount=type=cache,target=/root/.npm,id=npm-cache npm ci --omit=dev --ignore-scripts --no-audit --no-fund && \
    rm -rf /tmp/*

# Copy built files from builder stage
COPY --from=builder --chown=mcpuser:mcpuser /app/build ./build

# Switch to non-root user
USER mcpuser

# MCP uses stdio transport - no ports needed
# Entry point for MCP server
ENTRYPOINT ["node", "build/index.js"]

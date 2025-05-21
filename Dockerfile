# 1. Base Image
FROM node:20-slim

# 2. Set Working Directory
WORKDIR /usr/src/app

# 3. Install Chromium and dependencies
# Install Chromium and necessary dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium-browser \
    # Add other common puppeteer dependencies to prevent issues
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxshmfence1 \
    libasound2 \
    # End of common dependencies
    && rm -rf /var/lib/apt/lists/*

# 4. Set PUPPETEER_EXECUTABLE_PATH environment variable
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

# 5. Install Bun
RUN npm install -g bun@latest # Using latest, can be pinned to a specific version

# 6. Copy application files
# Copy package.json and bun.lockb first to leverage Docker layer caching
COPY package.json bun.lockb* ./
# tsconfig.json might not be strictly needed if only running pre-built JS,
# but good to include if any TS processing happens in the container or for consistency.
COPY tsconfig.json ./ 
COPY server.ts ./
# COPY tests ./tests/ # Optional: if you want/need tests in the image (e.g., for CI in Docker)

# 7. Install application dependencies
# Using --production to skip devDependencies like test frameworks
RUN bun install --production

# 8. Expose the application port
# Default to 3000 if PORT env var is not set at runtime
EXPOSE ${PORT:-3000}

# 9. Define the command to run the application
# Assumes "start" script in package.json is `bun server.ts` or `bun run server.ts`
CMD ["bun", "run", "start"]

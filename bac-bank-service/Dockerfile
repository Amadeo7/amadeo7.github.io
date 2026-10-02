FROM mcr.microsoft.com/playwright:v1.48.2-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production
# Navegador "headed" dentro del contenedor usando display virtual
CMD ["xvfb-run", "-a", "node", "dist/main"]

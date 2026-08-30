FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY configs ./configs
COPY fixtures ./fixtures
COPY policy ./policy
EXPOSE 8081
CMD ["node", "dist/production/server.mjs"]

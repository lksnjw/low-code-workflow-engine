FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# nginx's official image auto-substitutes ${VAR} placeholders in any
# *.template file here into /etc/nginx/conf.d/ at container startup, using
# the container's actual env vars (ERP_PIPELINE_API_URL / _API_KEY) — no
# custom entrypoint needed. See nginx.conf.template for what gets filled in.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]

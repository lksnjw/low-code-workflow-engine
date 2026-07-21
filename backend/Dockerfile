FROM golang:1.22-alpine AS build

WORKDIR /app
COPY go.mod go.sum* ./
RUN go mod download
COPY . .
RUN go build -buildvcs=false -o /agentic-orchestrator ./cmd/server

FROM alpine:3.20
WORKDIR /app
COPY --from=build /agentic-orchestrator /usr/local/bin/agentic-orchestrator
COPY .env.example .env.example
COPY dataset ./dataset
COPY configs /opt/agentic-orchestrator/configs
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["agentic-orchestrator"]

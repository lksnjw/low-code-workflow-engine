APP=agentic-orchestrator

.PHONY: run build test experiment tidy fmt

run:
	go run -buildvcs=false ./cmd/server

build:
	go build -buildvcs=false -o bin/$(APP) ./cmd/server

test:
	go test ./...

experiment:
	APP_ENV=experiment go run -buildvcs=false ./cmd/run-experiment

test-report:
	go install github.com/vakenbolt/go-test-report@latest
	go test -json ./... | go-test-report
	@echo "Test report generated at test_report.html"

tidy:
	go mod tidy

fmt:
	gofmt -w .

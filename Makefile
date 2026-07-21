.PHONY: build dev start test test-watch test-coverage fmt lint check clean release help

APP_NAME := commandcode-api-proxy
VERSION := $(shell node -p "require('./package.json').version")

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies
	pnpm install

build: ## Build TypeScript → dist/
	pnpm build

dev: ## Run in development mode with hot reload
	pnpm dev

start: build ## Build and start the proxy
	node dist/proxy.js

test: ## Run all tests
	pnpm test

test-watch: ## Run tests in watch mode
	pnpm test:watch

test-coverage: ## Run tests with coverage report
	pnpm test:coverage

clean: ## Clean build artifacts
	rm -rf dist/
	rm -rf coverage/

release: build test ## Build and test for release
	@echo "Ready for release: pnpm publish"

fmt: ## Format code with vp
	vp fmt

lint: ## Lint code with vp
	vp lint

typecheck: ## Type-check the code
	pnpm tsc --noEmit

check: ## Run all checks (format + lint + typecheck + test + build)
	vp check
	pnpm test
	pnpm build
	@echo "All checks passed"

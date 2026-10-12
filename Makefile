# Pagefreeze developer entry points.
#
# Everything is also available through pnpm scripts; the Makefile is a thin wrapper so the
# common commands are discoverable with `make help`.

.DEFAULT_GOAL := help
.PHONY: help install dev dev-web build test test-unit test-integration test-e2e coverage \
        lint lint-fix typecheck format migrate demo seed screenshots openapi \
        docker-build docker-up docker-down docker-logs clean

help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (pnpm workspaces)
	pnpm install

dev: ## Run the server in watch mode (migrations, scheduler, API)
	pnpm dev

dev-web: ## Run the Vite dev server for the frontend with API proxying
	pnpm dev-web

build: ## Build shared, server and the web SPA
	pnpm build

test: ## Run every test suite (unit + integration + web)
	pnpm test

test-unit: ## Unit tests only; no external services required
	pnpm test:unit

test-integration: ## Integration tests; needs PostgreSQL and Chromium
	pnpm test:integration

test-e2e: ## Playwright end-to-end test against a live stack
	pnpm test:e2e

coverage: ## Test coverage with the 80% server threshold enforced
	pnpm coverage

lint: ## ESLint across the monorepo
	pnpm lint

lint-fix: ## ESLint with --fix
	pnpm lint:fix

typecheck: ## tsc --noEmit for every package
	pnpm typecheck

format: ## Prettier across the monorepo
	pnpm format

migrate: ## Apply pending SQL migrations
	pnpm migrate

demo: ## Fixture site + seeded monitors + live server on :8080
	pnpm demo

seed: ## Seed example rows into the configured database
	pnpm seed

screenshots: ## Regenerate the real screenshots used in the README
	pnpm screenshots

openapi: ## Regenerate api/openapi.yaml from the zod schemas
	pnpm openapi

docker-build: ## Build the container image locally
	docker build -t pagefreeze:local .

docker-up: ## Start pagefreeze + postgres via compose
	docker compose up -d --build

docker-down: ## Stop the compose stack (volumes kept)
	docker compose down

docker-logs: ## Follow pagefreeze container logs
	docker compose logs -f pagefreeze

clean: ## Remove build output and coverage reports
	pnpm clean

COMPOSE := docker compose -f docker-compose.prod.yaml
COMPOSE_DEV := docker compose -f docker-compose.local.yaml

.PHONY: help dev dev-down dev-logs up down restart deploy build migrate _migrate pull logs ps psql redis-cli sh status health prune

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

dev: ## Start the local dev stack with hot-reload (foreground)
	$(COMPOSE_DEV) up

dev-down: ## Stop and remove the local dev stack
	$(COMPOSE_DEV) down

dev-logs: ## Tail logs from the local dev stack
	$(COMPOSE_DEV) logs -f --tail=200

up: ## Start the prod stack in the background
	$(COMPOSE) up -d

down: ## Stop and remove containers (volumes preserved)
	$(COMPOSE) down

restart: ## Restart all services
	$(COMPOSE) restart

build: ## Rebuild the app image
	$(COMPOSE) build app

deploy: ## Pull, rebuild app, run migrations, recreate changed services
	git pull --ff-only
	$(COMPOSE) build app
	$(MAKE) _migrate
	$(COMPOSE) up -d --remove-orphans

migrate: build _migrate ## Rebuild app image and run production database migrations

_migrate:
	$(COMPOSE) up -d --wait postgres redis
	$(COMPOSE) run --rm app npm run migration:run

logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=200

ps: ## Show service status
	$(COMPOSE) ps

status: ps ## Alias for ps

health: ## Show health status of each service
	@$(COMPOSE) ps --format 'table {{.Service}}\t{{.Status}}'

psql: ## Open a psql shell against the prod database
	$(COMPOSE) exec postgres sh -c 'psql -U $$POSTGRES_USER -d $$POSTGRES_DB'

redis-cli: ## Open redis-cli against the prod redis
	$(COMPOSE) exec redis redis-cli

sh: ## Shell into the running app container
	$(COMPOSE) exec app sh

prune: ## Remove dangling images and stopped containers
	docker system prune -f

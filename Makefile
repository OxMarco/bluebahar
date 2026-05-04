COMPOSE := docker compose -f docker-compose.prod.yaml

.PHONY: help up down restart deploy build pull logs ps psql redis-cli sh status health prune

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

up: ## Start the stack in the background
	$(COMPOSE) up -d

down: ## Stop and remove containers (volumes preserved)
	$(COMPOSE) down

restart: ## Restart all services
	$(COMPOSE) restart

build: ## Rebuild the app image
	$(COMPOSE) build app

deploy: ## Pull, rebuild app, recreate changed services
	git pull
	$(COMPOSE) build app
	$(COMPOSE) up -d --remove-orphans

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

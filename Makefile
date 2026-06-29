# videocalltizen — pilotage de la stack locale (source synthétique).
.PHONY: up down restart ps logs build test test-p1 test-p2 test-token test-signaling clean eufy-up

CORE := redis livekit ingress go2rtc token-service signaling web-client

up:            ## Monte le socle (sans Eufy)
	docker compose up -d --build $(CORE)
	bash scripts/wait-ready.sh 120

down:          ## Arrête la stack
	docker compose down

restart: down up

ps:
	docker compose ps

logs:          ## make logs S=ingress
	docker compose logs -f --tail=100 $(S)

build:
	docker compose build $(CORE)

test: ## Toute la suite (token, P1, P2, signaling, navigateur, eufy-shim)
	bash scripts/test-all.sh

test-browser:
	bash scripts/test-browser.sh

test-p1:
	bash scripts/test-p1-ingestion.sh

test-p2:
	bash scripts/test-p2-media.sh

test-token:
	bash scripts/test-token.sh

test-signaling:
	bash scripts/test-signaling.sh

# Profil 'eufy' — DÉMARRE l'ingestion réelle (touche la vraie caméra, concurrence Gardien).
eufy-up:       ## ⚠️ branche la vraie caméra Eufy (instance dédiée eufy-visio)
	@echo "⚠️  Ceci ouvre une session sur le compte Eufy réel et peut entrer en"
	@echo "    concurrence avec le Gardien pour l'unique slot P2P de la S350."
	docker compose --profile eufy up -d eufy-visio eufy-shim

clean:
	docker compose down -v --remove-orphans

# videocalltizen — pilotage de la stack locale (source synthétique).
.PHONY: up down restart ps logs build test test-p1 test-p2 test-token test-signaling clean eufy-up eufy-down

CORE := redis livekit ingress go2rtc token-service signaling web-client
EUFY_FILES := -f docker-compose.yml -f docker-compose.eufy.yml

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

# Profil 'eufy' — DÉMARRE l'ingestion réelle (touche la vraie caméra). go2rtc passe
# en mode RÉEL (source 'salon' = caméra, transcode H.265->H.264) via l'override.
eufy-up:       ## ⚠️ branche la vraie caméra Eufy (instance dédiée eufy-visio + transcode)
	@echo "⚠️  Ouvre une session sur le compte Eufy réel et fait streamer la caméra."
	docker compose $(EUFY_FILES) --profile eufy up -d --build go2rtc eufy-visio eufy-shim
	@echo "→ go2rtc en mode RÉEL. Suivre le shim : make logs S=eufy-shim"

eufy-down:     ## Arrête l'Eufy et remet go2rtc en mode synthétique
	docker compose $(EUFY_FILES) --profile eufy stop eufy-shim eufy-visio
	docker compose up -d go2rtc

clean:
	docker compose down -v --remove-orphans

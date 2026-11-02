GO_SERVICES := services/sync-core services/social-core
PY_SERVICES := services/media-worker services/analytics
COVERAGE_MIN := 85

NODE_SERVICES := services/identity-api
CPP_SERVICES := services/voice-core

.PHONY: up down test-all test-go test-python test-web test-node test-cpp test-stream smoke-stream load-stream load-voice e2e-voice observability health logs smoke-observability secrets smoke-secrets

up:
	docker compose up -d

down:
	docker compose down

test-all: test-go test-python test-web test-node test-cpp test-stream

test-go:
	@for svc in $(GO_SERVICES); do \
		echo "==> $$svc"; \
		(cd $$svc && go test -race -coverprofile=coverage.out ./... && \
		 ../../scripts/check-go-coverage.sh coverage.out $(COVERAGE_MIN)) || exit 1; \
	done

test-python:
	@for svc in $(PY_SERVICES); do \
		echo "==> $$svc"; \
		(cd $$svc && \
		 if [ -f .venv/bin/activate ]; then . .venv/bin/activate; fi && \
		 python3 -m pytest --cov=src --cov-fail-under=$(COVERAGE_MIN)) || exit 1; \
	done

test-web:
	cd apps/web && npm ci && npx vitest run --coverage

test-node:
	@for svc in $(NODE_SERVICES); do \
		echo "==> $$svc"; \
		(cd $$svc && npm ci && npm run typecheck && npx vitest run --coverage) || exit 1; \
	done

# C++: compila con cobertura, corre ctest y exige ≥ 85 % de líneas en src/ (gcovr).
test-cpp:
	@for svc in $(CPP_SERVICES); do \
		echo "==> $$svc"; \
		(cd $$svc && cmake -S . -B build-cov -G Ninja -DCMAKE_BUILD_TYPE=Debug -DVOICE_COVERAGE=ON && \
		 cmake --build build-cov && ctest --test-dir build-cov --output-on-failure && \
		 gcovr --root . --filter src/ --exclude src/main.cpp build-cov --fail-under-line $(COVERAGE_MIN)) || exit 1; \
	done

# stream-core (C++ SFU): libdatachannel no está empaquetada, así que todo corre en su imagen dev
# (como en CI). Para las pruebas de integración con Redis: STREAM_TEST_REDIS_URL=redis://host:6379.
STREAM_DEV := tint-stream-dev
test-stream:
	docker build --target dev -t $(STREAM_DEV) services/stream-core
	docker run --rm --user $$(id -u):$$(id -g) --network host -e STREAM_TEST_REDIS_URL -v $(PWD)/services/stream-core:/src -w /src $(STREAM_DEV) \
	  bash -euo pipefail -c 'clang-format --dry-run --Werror $$(find src tests -name "*.cpp" -o -name "*.hpp") && \
	    cmake -S . -B build-cov -G Ninja -DCMAKE_BUILD_TYPE=Debug -DSTREAM_COVERAGE=ON && cmake --build build-cov && \
	    ctest --test-dir build-cov --output-on-failure && \
	    gcovr --root . --filter src/ --exclude src/main.cpp --gcov-ignore-errors=no_working_dir_found build-cov --fail-under-line $(COVERAGE_MIN)'

# Prueba rápida contra stream-core levantado (docker compose up -d stream-core).
smoke-stream:
	python3 -I services/stream-core/scripts/smoke.py --url http://localhost:8086 --secret $${JWT_SECRET:-dev-secret-change-in-prod}

# Spike S2: publicador VP8 simulcast + VIEWERS bots WHEP (libdatachannel) contra stream-core en :8086.
# Si no está arriba, levanta redis + stream-core con compose y los baja al terminar. VIEWERS=50 DURATION=30.
load-stream:
	services/stream-core/loadtest/run.sh

# Carga de la señalización de voz (k6 en Docker contra voice-core en :8085).
load-voice:
	docker run --rm --network host -v $(PWD)/services/voice-core/loadtest:/lt:ro grafana/k6:0.54.0 run \
	  -e BASE_URL=ws://localhost:8085 -e JWT_SECRET=$${JWT_SECRET:-$$(grep -E '^JWT_SECRET=' .env 2>/dev/null | cut -d= -f2-)} \
	  -e VUS=$${VUS:-50} -e DURATION=$${DURATION:-20s} /lt/voice.js

# E2E de la voz con dos Chromium reales (ruta libre y solo TURN). Requiere la web, voice-core y coturn.
e2e-voice:
	services/voice-core/e2e/run.sh

# Observabilidad (OPS-04)
observability:
	python3 -m pytest gateway/tests/test_observability.py -q
	docker compose config -q
	docker compose -f docker-compose.yml -f docker-compose.production.yml config -q

health:
	docker compose ps

logs:
	docker compose logs -f --tail=100

smoke-observability:
	python3 scripts/observability_smoke.py

# Secretos por entorno (OPS-05, ADR 0022)
secrets:
	python3 -m unittest discover -s gateway/tests -v
	docker compose config -q
	docker compose -f docker-compose.yml -f docker-compose.production.yml config -q

smoke-secrets:
	python3 scripts/secrets_smoke.py

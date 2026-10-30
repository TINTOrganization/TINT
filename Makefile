GO_SERVICES := services/sync-core services/social-core
PY_SERVICES := services/media-worker services/analytics
COVERAGE_MIN := 85

NODE_SERVICES := services/identity-api
CPP_SERVICES := services/voice-core

.PHONY: up down test-all test-go test-python test-web test-node test-cpp load-voice e2e-voice

up:
	docker compose up -d

down:
	docker compose down

test-all: test-go test-python test-web test-node test-cpp

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

# Carga de la señalización de voz (k6 en Docker contra voice-core en :8085).
load-voice:
	docker run --rm --network host -v $(PWD)/services/voice-core/loadtest:/lt:ro grafana/k6:0.54.0 run \
	  -e BASE_URL=ws://localhost:8085 -e JWT_SECRET=$${JWT_SECRET:-$$(grep -E '^JWT_SECRET=' .env 2>/dev/null | cut -d= -f2-)} \
	  -e VUS=$${VUS:-50} -e DURATION=$${DURATION:-20s} /lt/voice.js

# E2E de la voz con dos Chromium reales (ruta libre y solo TURN). Requiere la web, voice-core y coturn.
e2e-voice:
	services/voice-core/e2e/run.sh

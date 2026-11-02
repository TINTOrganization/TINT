# stream-core — Transmisión en vivo (C++ SFU)

El host transmite su pantalla una sola vez y stream-core la reenvía a cada espectador. La señalización es WHIP/WHEP por HTTP y los medios viajan por WebRTC, sobre [libdatachannel](https://github.com/paullouisageneau/libdatachannel).

- Guía del dominio para agentes y personas: [AGENTS.md](AGENTS.md)
- Especificación, API y performance: [docs/dominio-transmision.md](../../docs/dominio-transmision.md)

## Requisitos
- Docker. No necesitas toolchain local: libdatachannel no está en Debian ni en Ubuntu, así que se compila una vez en la imagen `dev`.
- Para las pruebas de integración, un Redis (opcional).

## Correr las pruebas
Desde la raíz del repositorio:

```bash
make test-stream
```

Esto construye la imagen `dev`, revisa el formato, compila, corre las ~260 pruebas y exige ≥ 85 % de cobertura. Las 4 pruebas de Redis se saltan si no hay Redis. Para incluirlas:

```bash
docker run -d --name redis-test -p 6379:6379 redis:7-alpine
STREAM_TEST_REDIS_URL=redis://localhost:6379 make test-stream
```

Para un ciclo rápido de desarrollo, sin cobertura:

```bash
docker build --target dev -t tint-stream-dev services/stream-core
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/services/stream-core:/src" -w /src tint-stream-dev bash -c \
  'cmake -S . -B build -G Ninja && cmake --build build && ./build/stream_core_tests && ./build/stream_core_rtc_tests'
```

## Levantar el servicio
```bash
cp .env.example .env          # STREAM_PUBLIC_IP=127.0.0.1 si el navegador está en la misma máquina
docker compose up -d redis stream-core
curl localhost:8086/healthz   # {"service":"stream-core","status":"ok"}
make smoke-stream             # recorre 401/403/404/410/415/400/201 contra el servicio
```

Puertos: **8086/tcp** (HTTP) y **8087/udp** (medios WebRTC).

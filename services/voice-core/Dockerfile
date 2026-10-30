# voice-core: Canal de Voz de TINT (C++20/23, Boost.Beast, hiredis).
# La etapa "dev" es el entorno de compilación y pruebas (make test-cpp / desarrollo local);
# "build" compila en Release y la imagen final solo lleva el binario y sus bibliotecas.
FROM debian:trixie-slim AS dev
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake ninja-build g++ libboost-dev libssl-dev libhiredis-dev \
      nlohmann-json3-dev libgtest-dev libgmock-dev pkgconf gcovr clang-format git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src

FROM dev AS build
COPY . /src
RUN cmake -S . -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release -DVOICE_BUILD_TESTS=OFF \
    && cmake --build /build --target voice-core

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3t64 libhiredis1.1.0 curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home voicecore
COPY --from=build /build/voice-core /usr/local/bin/voice-core
USER voicecore
EXPOSE 8085
HEALTHCHECK --interval=10s --timeout=3s CMD curl -fs http://localhost:8085/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/voice-core"]

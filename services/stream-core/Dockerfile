# stream-core: Transmisión en vivo de TINT (SFU C++23 sobre libdatachannel).
# "dev": entorno de compilación y pruebas (incluye libdatachannel fijada, compilada una vez).
# "build": compila en Release. La imagen final solo lleva el binario y sus bibliotecas.
FROM debian:trixie-slim AS dev
RUN apt-get update && apt-get install -y --no-install-recommends \
      cmake ninja-build g++ libboost-dev libssl-dev libhiredis-dev libsrtp2-dev \
      nlohmann-json3-dev libgtest-dev libgmock-dev pkgconf gcovr clang-format git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
# libdatachannel no está empaquetada en Debian (ADR 0017). Versión fijada con el commit al que apunta el tag.
ARG LIBDATACHANNEL_TAG=v0.24.6
ARG LIBDATACHANNEL_SHA=6b1e2e620f1e37f0eafeee702eaea0043cb305fd
RUN git clone --depth 1 --branch "$LIBDATACHANNEL_TAG" https://github.com/paullouisageneau/libdatachannel.git /tmp/ldc \
    && test "$(git -C /tmp/ldc rev-parse HEAD)" = "$LIBDATACHANNEL_SHA" \
    && git -C /tmp/ldc submodule update --init --depth 1 deps/libjuice deps/usrsctp deps/plog deps/json \
    && cmake -S /tmp/ldc -B /tmp/ldc/build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo \
         -DUSE_SYSTEM_SRTP=ON -DNO_WEBSOCKET=ON -DNO_EXAMPLES=ON -DNO_TESTS=ON -DBUILD_SHARED_LIBS=ON \
    && cmake --build /tmp/ldc/build && cmake --install /tmp/ldc/build && ldconfig && rm -rf /tmp/ldc
WORKDIR /src

FROM dev AS build
COPY . /src
RUN cmake -S . -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release -DSTREAM_BUILD_TESTS=OFF \
    && cmake --build /build --target stream-core \
    && strip --strip-unneeded /build/stream-core \
    && strip --strip-unneeded -o /build/libdatachannel.so.0.24 /usr/local/lib/libdatachannel.so.0.24.6

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends libssl3t64 libhiredis1.1.0 libsrtp2-1 curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home streamcore
# Solo el archivo del SONAME y sin símbolos: un COPY con glob duplicaba la .so (3 × 38 MB con debug).
COPY --from=build /build/libdatachannel.so.0.24 /usr/local/lib/
RUN ldconfig
COPY --from=build /build/stream-core /usr/local/bin/stream-core
USER streamcore
EXPOSE 8086 8087/udp
HEALTHCHECK --interval=10s --timeout=3s CMD curl -fs http://localhost:8086/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/stream-core"]

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sync-core .

FROM alpine:3.20
COPY --from=build /out/sync-core /sync-core
RUN adduser -D -H app
USER app
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s CMD wget --spider --quiet http://localhost:8080/healthz || exit 1
ENTRYPOINT ["/sync-core"]

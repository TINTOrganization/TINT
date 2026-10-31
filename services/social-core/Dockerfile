FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/social-core .

FROM alpine:3.20
COPY --from=build /out/social-core /social-core
RUN adduser -D -H app
USER app
EXPOSE 8082
HEALTHCHECK --interval=10s --timeout=3s CMD wget --spider --quiet http://localhost:8082/healthz || exit 1
ENTRYPOINT ["/social-core"]

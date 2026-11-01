package server

import (
	"encoding/json"
	"log"
	"net/http"
	"regexp"
	"time"
)

const correlationHeader = "X-Correlation-ID"

var safeCorrelationID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

func requestCorrelationID(r *http.Request) string {
	if value := r.Header.Get(correlationHeader); safeCorrelationID.MatchString(value) {
		return value
	}
	return newUUID()
}

func withCorrelation(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := requestCorrelationID(r)
		w.Header().Set(correlationHeader, id)
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf(`{"level":"info","message":"http_request","correlation_id":%q,"method":%q,"path":%q,"duration_ms":%d}`, id, r.Method, r.URL.Path, time.Since(start).Milliseconds())
	})
}

func correlationError(w http.ResponseWriter, r *http.Request, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{
		"error":          message,
		"correlation_id": requestCorrelationID(r),
	})
}

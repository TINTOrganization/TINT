// Package reactions implementa el control anti-spam y el bucketing de reacciones.
package reactions

import (
	"sync"
	"time"
)

const (
	// MaxPerSecond es el máximo de reacciones permitidas por usuario por segundo.
	MaxPerSecond = 5
	// BucketSize es la ventana de agregación de reacciones para el heatmap.
	BucketSize = 5 * time.Second
)

// Limiter aplica una ventana deslizante de 1s por usuario.
type Limiter struct {
	mu      sync.Mutex
	limit   int
	window  time.Duration
	history map[string][]time.Time
}

// NewLimiter crea un limitador con el límite por defecto de TINT.
func NewLimiter() *Limiter {
	return NewLimiterWith(MaxPerSecond, time.Second)
}

// NewLimiterWith crea un limitador de limit eventos por window y usuario
// (p. ej. el puntero láser, 30/s). Valores ≤ 0 usan los de TINT (5/s).
func NewLimiterWith(limit int, window time.Duration) *Limiter {
	if limit <= 0 {
		limit = MaxPerSecond
	}
	if window <= 0 {
		window = time.Second
	}
	return &Limiter{limit: limit, window: window, history: make(map[string][]time.Time)}
}

// Allow indica si el usuario puede emitir una reacción en el instante now.
func (l *Limiter) Allow(userID string, now time.Time) bool {
	allowed, _ := l.AllowWithRetry(userID, now)
	return allowed
}

// AllowWithRetry indica si el evento puede pasar y, si no, cuánto debe esperar
// el cliente antes de reintentarlo.
func (l *Limiter) AllowWithRetry(userID string, now time.Time) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()

	cutoff := now.Add(-l.window)
	recent := l.history[userID][:0]
	for _, t := range l.history[userID] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.limit {
		l.history[userID] = recent
		retry := recent[0].Add(l.window).Sub(now)
		if retry < time.Millisecond {
			retry = time.Millisecond
		}
		return false, retry
	}
	l.history[userID] = append(recent, now)
	return true, 0
}

// BucketIndex devuelve el índice del bucket de 5s para una posición del vídeo.
func BucketIndex(position time.Duration) int64 {
	if position < 0 {
		return 0
	}
	return int64(position / BucketSize)
}

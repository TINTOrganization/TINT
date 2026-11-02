// Package chat — historial corto en Redis.
package chat

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"time"

	"github.com/HanamDavid/tint-monorepo/services/social-core/internal/socialevent"
	"github.com/redis/go-redis/v9"
)

// HistoryTTL es el periodo de gracia de la sala (REQ-07): 12 horas.
const HistoryTTL = 12 * time.Hour

// RedisStore persiste el historial corto (LIST) y publica en Pub/Sub.
type RedisStore struct {
	client *redis.Client
	limit  int
	ttl    time.Duration
}

// NewRedisStore crea el store sobre la URL dada.
func NewRedisStore(url string, limit int, ttl time.Duration) (*RedisStore, error) {
	if limit <= 0 {
		limit = HistoryLimit
	}
	if ttl <= 0 {
		ttl = HistoryTTL
	}
	opt, err := redis.ParseURL(url)
	if err != nil {
		return nil, err
	}
	return &RedisStore{client: redis.NewClient(opt), limit: limit, ttl: ttl}, nil
}

// NewRedisStoreWithClient inyecta un cliente (tests/integración).
func NewRedisStoreWithClient(client *redis.Client, limit int, ttl time.Duration) *RedisStore {
	if limit <= 0 {
		limit = HistoryLimit
	}
	if ttl <= 0 {
		ttl = HistoryTTL
	}
	return &RedisStore{client: client, limit: limit, ttl: ttl}
}

func (s *RedisStore) Push(ctx context.Context, roomID string, msg socialevent.ChatMessage) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	key := HistoryKey(roomID)
	pipe := s.client.Pipeline()
	pipe.LPush(ctx, key, raw)
	pipe.LTrim(ctx, key, 0, int64(s.limit-1))
	pipe.Expire(ctx, key, s.ttl)
	_, err = pipe.Exec(ctx)
	return err
}

func (s *RedisStore) Recent(ctx context.Context, roomID string, limit int) ([]socialevent.ChatMessage, error) {
	if limit <= 0 {
		limit = s.limit
	}
	raws, err := s.client.LRange(ctx, HistoryKey(roomID), 0, int64(limit-1)).Result()
	if err != nil {
		return nil, err
	}
	// LPUSH guarda newest-first: invertimos a cronológico.
	out := make([]socialevent.ChatMessage, 0, len(raws))
	for i := len(raws) - 1; i >= 0; i-- {
		var m socialevent.ChatMessage
		if err := json.Unmarshal([]byte(raws[i]), &m); err != nil {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

// Publish emite el mensaje al canal de la sala (multirréplica).
func (s *RedisStore) Publish(ctx context.Context, roomID string, msg socialevent.ChatMessage) error {
	raw, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	return s.client.Publish(ctx, ChannelKey(roomID), raw).Err()
}

// PublishReaction emite una reacción al canal de la sala (multirréplica).
func (s *RedisStore) PublishReaction(ctx context.Context, roomID string, r socialevent.Reaction) error {
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return s.client.Publish(ctx, ChannelKey(roomID), raw).Err()
}

// PublishRaw emite un evento ya serializado (laser, poll_state) al canal
// de la sala (multirréplica).
func (s *RedisStore) PublishRaw(ctx context.Context, roomID string, payload []byte) error {
	return s.client.Publish(ctx, ChannelKey(roomID), payload).Err()
}

// IsRevoked indica si identity-api revocó el jti (EXISTS token:revoked:{jti}).
// Un error de Redis se devuelve tal cual: el llamador debe fallar cerrado.
func (s *RedisStore) IsRevoked(ctx context.Context, jti string) (bool, error) {
	n, err := s.client.Exists(ctx, RevokedKey(jti)).Result()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// IsRoomClosed indica si identity-api deshabilitó la sala
// (EXISTS room:{id}:closed). Un error se devuelve: el llamador falla cerrado.
func (s *RedisStore) IsRoomClosed(ctx context.Context, roomID string) (bool, error) {
	n, err := s.client.Exists(ctx, ClosedKey(roomID)).Result()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// IsLive indica si la sala es de transmisión (room:{id}:kind == "live").
func (s *RedisStore) IsLive(ctx context.Context, roomID string) (bool, error) {
	kind, err := s.client.Get(ctx, KindKey(roomID)).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return kind == "live", nil
}

// StreamStartedAt lee started_at_ms del stream (ok = false si no empezó o
// el valor no es un entero positivo).
func (s *RedisStore) StreamStartedAt(ctx context.Context, roomID string) (int64, bool, error) {
	raw, err := s.client.Get(ctx, StreamStartedKey(roomID)).Result()
	if errors.Is(err, redis.Nil) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	ms, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || ms <= 0 {
		return 0, false, nil
	}
	return ms, true, nil
}

// Fuentes de un payload de Pub/Sub.
const (
	sourceSocial = iota
	sourceSync
	sourceStream
)

// Subscribe abre UNA suscripción por sala a room:{id}:social (eventos de
// otras réplicas), room:{id}:sync (REVOKED y ROOM_CLOSED de identity-api y
// comandos de reproducción de sync-core para el recap) y room:{id}:stream
// (STREAM_STARTED/STREAM_ENDED de stream-core); los dos últimos, solo lectura.
func (s *RedisStore) Subscribe(ctx context.Context, roomID string) (<-chan Inbound, func()) {
	out := make(chan Inbound, 64)
	social, sync, stream := ChannelKey(roomID), SyncChannelKey(roomID), StreamChannelKey(roomID)
	sub := s.client.Subscribe(ctx, social, sync, stream)
	ch := sub.Channel()
	done := make(chan struct{})
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case payload, ok := <-ch:
				if !ok {
					return
				}
				source := sourceSocial
				switch payload.Channel {
				case sync:
					source = sourceSync
				case stream:
					source = sourceStream
				}
				in, ok := decodeInbound(source, roomID, []byte(payload.Payload))
				if !ok {
					continue
				}
				if in.RevokedJTI != "" || in.RoomClosed || in.Stream != nil {
					// Una revocación, un cierre de sala o un cambio del stream
					// no se descartan aunque el buffer esté lleno.
					select {
					case out <- in:
					case <-ctx.Done():
						return
					case <-done:
						return
					}
					continue
				}
				select {
				case out <- in:
				default:
				}
			}
		}
	}()
	return out, func() { close(done); _ = sub.Close() }
}

// decodeInbound traduce un payload de Pub/Sub. Del canal de sync interesan
// REVOKED, ROOM_CLOSED y los comandos de reproducción (recap); del de
// stream, STREAM_STARTED/STREAM_ENDED; del social, los eventos de otras
// réplicas (se re-serializan por tipo: nunca se reenvía JSON arbitrario).
// Lo mal formado o de otra sala se descarta (dominio-transmision §6.1).
func decodeInbound(source int, roomID string, raw []byte) (Inbound, bool) {
	switch source {
	case sourceStream:
		var ev socialevent.StreamEvent
		if json.Unmarshal(raw, &ev) != nil || !ev.Valid(roomID) {
			return Inbound{}, false
		}
		return Inbound{Stream: &ev}, true
	case sourceSync:
		var ev struct {
			socialevent.SyncEvent
			JTI    string `json:"jti"`
			RoomID string `json:"room_id"`
			Reason string `json:"reason"`
		}
		if json.Unmarshal(raw, &ev) != nil {
			return Inbound{}, false
		}
		if ev.Type == socialevent.RoomClosed {
			closed := socialevent.BusClosed{Type: ev.Type, EventID: ev.EventID, RoomID: ev.RoomID, Reason: ev.Reason}
			return Inbound{RoomClosed: true}, closed.Valid(roomID)
		}
		if ev.Type == "REVOKED" && ev.JTI != "" {
			return Inbound{RevokedJTI: ev.JTI}, true
		}
		if ev.Positional() && ev.EventID != "" && ev.PositionMS >= 0 {
			sync := ev.SyncEvent
			return Inbound{Sync: &sync}, true
		}
		return Inbound{}, false
	}
	var head struct {
		Type    socialevent.Type `json:"type"`
		EventID string           `json:"event_id"`
	}
	if json.Unmarshal(raw, &head) != nil || head.EventID == "" {
		return Inbound{}, false
	}
	var v any
	switch head.Type {
	case socialevent.TypeChatMessage:
		v = &socialevent.ChatMessage{}
	case socialevent.TypeReaction:
		v = &socialevent.Reaction{}
	case socialevent.TypeLaser:
		v = &socialevent.Laser{}
	case socialevent.TypePollState:
		v = &socialevent.PollState{}
	case socialevent.TypeChatSettings:
		v = &socialevent.ChatSettings{}
	case socialevent.TypeTriviaQuestion:
		v = &socialevent.TriviaQuestion{}
	case socialevent.TypeTriviaResult:
		v = &socialevent.TriviaResult{}
	default:
		return Inbound{}, false
	}
	if json.Unmarshal(raw, v) != nil {
		return Inbound{}, false
	}
	payload, err := json.Marshal(v)
	if err != nil {
		return Inbound{}, false
	}
	return Inbound{EventID: head.EventID, Type: head.Type, Payload: payload}, true
}

// Client expone el cliente Redis para los stores que comparten conexión
// (encuestas, recap) y para el emisor de analítica (internal/analytics).
func (s *RedisStore) Client() *redis.Client {
	return s.client
}

// Close libera el cliente.
func (s *RedisStore) Close() error {
	return s.client.Close()
}

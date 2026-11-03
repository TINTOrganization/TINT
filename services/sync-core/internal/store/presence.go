package store

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/syncevent"
)

// Presence es la foto de presencia de una sala compartida por las réplicas.
type Presence struct {
	Online          int64  // conexiones host/cohost que latieron dentro del timeout
	Delegate        string // sub del participante con control delegado ("" = nadie)
	HostlessSinceMs int64  // desde cuándo la sala perdió a su host (0 = no aplica)
}

// hostStatusScript guarda el último HOST_STATUS y devuelve 1 solo en las
// transiciones, así varias réplicas pueden evaluarlo sin publicar
// duplicados. Una sala que nunca tuvo host no "pierde" al host.
// KEYS: host_online, hostless_since. ARGV: "1"/"0", ahora ms, ttl ms.
var hostStatusScript = redis.NewScript(`
local prev = redis.call('GET', KEYS[1])
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
if ARGV[1] == '1' then
  redis.call('DEL', KEYS[2])
elseif prev == '1' then
  redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
end
if prev == ARGV[1] or (not prev and ARGV[1] == '0') then return 0 end
return 1
`)

// sweepScript hace en una ida y vuelta lo que Beat + Presence +
// SetHostStatus: latido en lote, foto de presencia (hostless_since leído
// antes de actualizarlo, igual que antes) y transición de HOST_STATUS.
// KEYS: hosts_online, members, sync_state, host_online, hostless_since,
// delegate. ARGV: ahora ms, ttl ms, umbral de presencia, nº de hosts,
// conexiones de host…, subs de participantes….
var sweepScript = redis.NewScript(`
local now, ttl, nh = ARGV[1], ARGV[2], tonumber(ARGV[4])
local function beat(key, from, to)
  if to < from then return end
  local args = {}
  for i = from, to do
    args[#args + 1] = now
    args[#args + 1] = ARGV[i]
    if #args >= 200 then
      redis.call('ZADD', key, unpack(args))
      args = {}
    end
  end
  if #args > 0 then redis.call('ZADD', key, unpack(args)) end
  redis.call('PEXPIRE', key, ttl)
end
beat(KEYS[1], 5, 4 + nh)
beat(KEYS[2], 5 + nh, #ARGV)
if #ARGV >= 5 then redis.call('PEXPIRE', KEYS[3], ttl) end
local online = redis.call('ZCOUNT', KEYS[1], ARGV[3], '+inf')
local delegate = redis.call('GET', KEYS[6]) or ''
local since = redis.call('GET', KEYS[5]) or ''
local flag = '0'
if online > 0 then flag = '1' end
local prev = redis.call('GET', KEYS[4])
redis.call('SET', KEYS[4], flag, 'PX', ttl)
if flag == '1' then
  redis.call('DEL', KEYS[5])
elseif prev == '1' then
  redis.call('SET', KEYS[5], now, 'PX', ttl)
end
local changed = 1
if prev == flag or (not prev and flag == '0') then changed = 0 end
return {online, delegate, since, changed}
`)

// Sweep registra el latido de las conexiones locales (como Beat; listas
// vacías = sin latido), lee la presencia y guarda HOST_STATUS en una sola
// ida y vuelta. Devuelve la presencia (con hostless_since previo a esta
// evaluación) y si el estado del host cambió.
func (s *Store) Sweep(ctx context.Context, roomID string, hostConns, memberSubs []string, nowMs int64) (Presence, bool, error) {
	keys := []string{
		syncevent.HostsKey(roomID), syncevent.MembersKey(roomID), syncevent.StateKey(roomID),
		syncevent.HostStatusKey(roomID), syncevent.HostlessSinceKey(roomID), syncevent.DelegateKey(roomID),
	}
	args := make([]any, 0, 4+len(hostConns)+len(memberSubs))
	args = append(args, nowMs, s.ttl.Milliseconds(), sinceArg(nowMs), len(hostConns))
	for _, c := range hostConns {
		args = append(args, c)
	}
	for _, m := range memberSubs {
		args = append(args, m)
	}
	res, err := sweepScript.Run(ctx, s.rdb, keys, args...).Slice()
	if err != nil {
		return Presence{}, false, err
	}
	if len(res) != 4 {
		return Presence{}, false, fmt.Errorf("sweep sala %s: respuesta inesperada %v", roomID, res)
	}
	online, _ := res[0].(int64)
	delegate, _ := res[1].(string)
	since, _ := res[2].(string)
	changed, _ := res[3].(int64)
	sinceMs, _ := strconv.ParseInt(since, 10, 64)
	return Presence{Online: online, Delegate: delegate, HostlessSinceMs: sinceMs}, changed == 1, nil
}

// Beat registra un latido de las conexiones host/cohost (por id de
// conexión) y de los participantes (por sub) de esta réplica. En el mismo
// pipeline renueva el TTL de sync_state: una sala con clientes conectados
// pero sin comandos no debe perder su estado (REQ-07). PEXPIRE no crea la
// clave si no existe.
func (s *Store) Beat(ctx context.Context, roomID string, hostConns, memberSubs []string, nowMs int64) error {
	if len(hostConns) == 0 && len(memberSubs) == 0 {
		return nil
	}
	_, err := s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		zadd(ctx, p, syncevent.HostsKey(roomID), hostConns, nowMs, s.ttl)
		zadd(ctx, p, syncevent.MembersKey(roomID), memberSubs, nowMs, s.ttl)
		p.PExpire(ctx, syncevent.StateKey(roomID), s.ttl)
		return nil
	})
	return err
}

func zadd(ctx context.Context, p redis.Pipeliner, key string, members []string, nowMs int64, ttl time.Duration) {
	if len(members) == 0 {
		return
	}
	zs := make([]redis.Z, len(members))
	for i, m := range members {
		zs[i] = redis.Z{Score: float64(nowMs), Member: m}
	}
	p.ZAdd(ctx, key, zs...)
	p.PExpire(ctx, key, ttl)
}

// BeatPresence registra un latido (como Beat) y lee la presencia (como
// Presence) en una sola ida y vuelta. Lo usa Connect para el STATE inicial.
func (s *Store) BeatPresence(ctx context.Context, roomID string, hostConns, memberSubs []string, nowMs int64) (Presence, error) {
	var (
		online   *redis.IntCmd
		delegate *redis.StringCmd
		since    *redis.StringCmd
	)
	_, err := s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		zadd(ctx, p, syncevent.HostsKey(roomID), hostConns, nowMs, s.ttl)
		zadd(ctx, p, syncevent.MembersKey(roomID), memberSubs, nowMs, s.ttl)
		if len(hostConns) > 0 || len(memberSubs) > 0 {
			p.PExpire(ctx, syncevent.StateKey(roomID), s.ttl)
		}
		online, delegate, since = presenceCmds(ctx, p, roomID, nowMs)
		return nil
	})
	if err != nil && !errors.Is(err, redis.Nil) {
		return Presence{}, err
	}
	return presenceOf(online, delegate, since), nil
}

func presenceCmds(ctx context.Context, p redis.Pipeliner, roomID string, nowMs int64) (*redis.IntCmd, *redis.StringCmd, *redis.StringCmd) {
	return p.ZCount(ctx, syncevent.HostsKey(roomID), sinceArg(nowMs), "+inf"),
		p.Get(ctx, syncevent.DelegateKey(roomID)),
		p.Get(ctx, syncevent.HostlessSinceKey(roomID))
}

func presenceOf(online *redis.IntCmd, delegate, since *redis.StringCmd) Presence {
	sinceMs, _ := strconv.ParseInt(since.Val(), 10, 64)
	return Presence{Online: online.Val(), Delegate: delegate.Val(), HostlessSinceMs: sinceMs}
}

// MemberGone quita a un participante de la presencia.
func (s *Store) MemberGone(ctx context.Context, roomID, sub string) error {
	return s.rdb.ZRem(ctx, syncevent.MembersKey(roomID), sub).Err()
}

// Presence lee en una ida y vuelta los hosts vivos, el delegado y desde
// cuándo la sala no tiene host.
func (s *Store) Presence(ctx context.Context, roomID string, nowMs int64) (Presence, error) {
	var (
		online   *redis.IntCmd
		delegate *redis.StringCmd
		since    *redis.StringCmd
	)
	_, err := s.rdb.Pipelined(ctx, func(p redis.Pipeliner) error {
		online, delegate, since = presenceCmds(ctx, p, roomID, nowMs)
		return nil
	})
	if err != nil && !errors.Is(err, redis.Nil) {
		return Presence{}, err
	}
	return presenceOf(online, delegate, since), nil
}

// SetHostStatus guarda si la sala tiene host y dice si es una transición.
func (s *Store) SetHostStatus(ctx context.Context, roomID string, online bool, nowMs int64) (bool, error) {
	flag := "0"
	if online {
		flag = "1"
	}
	keys := []string{syncevent.HostStatusKey(roomID), syncevent.HostlessSinceKey(roomID)}
	n, err := hostStatusScript.Run(ctx, s.rdb, keys, flag, nowMs, s.ttl.Milliseconds()).Int()
	return n == 1, err
}

// LiveMembers devuelve los participantes que latieron dentro del timeout,
// ordenados: todas las réplicas eligen el mismo delegado.
func (s *Store) LiveMembers(ctx context.Context, roomID string, nowMs int64) ([]string, error) {
	members, err := s.rdb.ZRangeByScore(ctx, syncevent.MembersKey(roomID), &redis.ZRangeBy{Min: sinceArg(nowMs), Max: "+inf"}).Result()
	if err != nil {
		return nil, err
	}
	slices.Sort(members)
	return members, nil
}

// SwapDelegate fija el delegado (sub vacío lo anula) y devuelve el anterior.
func (s *Store) SwapDelegate(ctx context.Context, roomID, sub string) (string, error) {
	key := syncevent.DelegateKey(roomID)
	var prev string
	var err error
	if sub == "" {
		prev, err = s.rdb.GetDel(ctx, key).Result()
	} else {
		prev, err = s.rdb.SetArgs(ctx, key, sub, redis.SetArgs{Get: true, TTL: s.ttl}).Result()
	}
	if errors.Is(err, redis.Nil) {
		return "", nil
	}
	return prev, err
}

// IsRevoked indica si identity-api revocó el token con ese jti.
func (s *Store) IsRevoked(ctx context.Context, jti string) (bool, error) {
	if jti == "" {
		return false, nil
	}
	n, err := s.rdb.Exists(ctx, syncevent.RevokedKey(jti)).Result()
	return n > 0, err
}

// IsRoomClosed indica si identity-api deshabilitó la sala (room:{id}:closed).
func (s *Store) IsRoomClosed(ctx context.Context, roomID string) (bool, error) {
	n, err := s.rdb.Exists(ctx, syncevent.ClosedKey(roomID)).Result()
	return n > 0, err
}

func sinceArg(nowMs int64) string {
	return strconv.FormatInt(nowMs-PresenceTimeout.Milliseconds(), 10)
}

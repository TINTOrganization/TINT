// Package drift detecta y corrige desfases entre un cliente y el Reloj
// Maestro (SYNC-BE-04, REQ-28).
//
// El RTT se mide únicamente con el reloj del servidor (HEARTBEAT → SYNC_CHECK
// devuelve el server_ts original), por lo que el skew del reloj del cliente
// no afecta el cálculo.
package drift

import "github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"

const (
	// ThresholdMs es el desfase tolerado; por encima se corrige y se reporta.
	ThresholdMs = 500
	// SeekThresholdMs separa la corrección suave (rate) del salto (seek).
	SeekThresholdMs = 2000
	// RTTClampSlackMs es el margen fijo del recorte de muestras de RTT
	// (máximo aceptado = 2·RTT previo + RTTClampSlackMs).
	RTTClampSlackMs = 200
	// SeekCooldownMs: tras enviar un seek a un cliente no se le envía otro
	// durante este tiempo (las correcciones por rate siguen permitidas). Un
	// cliente en stall reporta una posición congelada y, sin enfriamiento,
	// cada latido producía otro seek que volvía a provocar el stall.
	SeekCooldownMs = 3000
)

// Strategy indica cómo debe realinearse el reproductor del cliente.
type Strategy string

const (
	Rate Strategy = "rate" // ajustar playbackRate temporalmente
	Seek Strategy = "seek" // saltar directamente a TargetMs
)

// Correction es la orden de ajuste enviada como SYNC_CORRECTION.
type Correction struct {
	TargetMs int64 // posición maestra estimada cuando el mensaje llegue al cliente
	Strategy Strategy
	DriftMs  int64 // + adelantado, − atrasado
	Version  int64 // versión del estado usado para el cálculo
}

// UpdateRTT suaviza el RTT con una media móvil exponencial (α = 0.2).
// Las muestras negativas son imposibles con un solo reloj y se descartan.
// Tras la primera muestra, una atípica (pestaña en segundo plano, pausa de
// GC del cliente, SYNC_CHECK encolado tras un stall) se recorta a
// RTTClamp(prev) antes de la EWMA: sin el recorte, un solo pico de 5 s
// inflaba el RTT a ~1 s y target_ms quedaba adelantado durante segundos.
func UpdateRTT(prevMs, sampleMs int64) int64 {
	if sampleMs < 0 {
		return prevMs
	}
	if prevMs == 0 {
		return sampleMs
	}
	sampleMs = min(sampleMs, RTTClamp(prevMs))
	return (prevMs*4 + sampleMs) / 5
}

// RTTClamp es la muestra máxima aceptada dado el RTT suavizado previo.
func RTTClamp(prevMs int64) int64 { return 2*prevMs + RTTClampSlackMs }

// Check compara la posición reportada por el cliente con la maestra.
// receivedAtMs es cuando llegó el SYNC_CHECK; el cliente leyó su posición
// ~rtt/2 antes. nowMs es el instante en que se emitirá la respuesta.
func Check(s master.State, clientPosMs, receivedAtMs, rttMs, nowMs int64) (int64, *Correction) {
	half := max(rttMs, 0) / 2
	drift := clientPosMs - s.PositionAt(receivedAtMs-half)
	if abs(drift) <= ThresholdMs {
		return drift, nil
	}

	strategy := Rate
	if s.Status != master.Playing || abs(drift) > SeekThresholdMs {
		strategy = Seek
	}
	return drift, &Correction{
		TargetMs: s.PositionAt(nowMs + half),
		Strategy: strategy,
		DriftMs:  drift,
		Version:  s.Version,
	}
}

func abs(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

package drift

import (
	"testing"

	"github.com/HanamDavid/tint-monorepo/services/sync-core/internal/master"
)

const t0 = int64(1_791_655_200_000)

func TestUpdateRTT(t *testing.T) {
	tests := []struct {
		name         string
		prev, sample int64
		want         int64
	}{
		{"primera muestra se adopta tal cual", 0, 120, 120},
		{"EWMA 0.8/0.2", 100, 200, 120},
		{"muestra negativa (skew) se descarta", 100, -30, 100},
		{"muestra cero es válida", 100, 0, 80},
		// Atípica (pestaña en segundo plano, GC del cliente): se recorta a
		// 2·prev+200 antes de la EWMA para no inflar target_ms durante segundos.
		{"muestra atípica se recorta a 2*prev+200", 100, 5_000, (100*4 + 400) / 5},
		{"justo en el límite no se recorta", 100, 400, (100*4 + 400) / 5},
		{"con prev pequeño el margen fijo de 200 manda", 10, 1_000, (10*4 + 220) / 5},
		{"la primera muestra no se recorta", 0, 5_000, 5_000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := UpdateRTT(tt.prev, tt.sample); got != tt.want {
				t.Errorf("UpdateRTT(%d,%d) = %d, want %d", tt.prev, tt.sample, got, tt.want)
			}
		})
	}
}

func TestCheck(t *testing.T) {
	// Sala reproduciendo desde 0 en t0: a t0+10s la posición maestra es 10000.
	playing := master.State{Status: master.Playing, PositionMs: 0, UpdatedAtMs: t0, Rate: 1, Version: 3}
	paused := master.State{Status: master.Paused, PositionMs: 10_000, UpdatedAtMs: t0, Rate: 1, Version: 3}

	// El cliente reporta en received=t0+10_100 con rtt=200:
	// midió su posición en t0+10_000 → esperado 10000.
	recv := t0 + 10_100
	const rtt = 200
	now := recv + 5 // tiempo de proceso en el servidor

	tests := []struct {
		name      string
		state     master.State
		clientPos int64
		wantDrift int64
		want      *Correction
	}{
		{"alineado", playing, 10_000, 0, nil},
		{"exactamente 500 adelantado no corrige", playing, 10_500, 500, nil},
		{"exactamente 500 atrasado no corrige", playing, 9_500, -500, nil},
		{
			"501 atrasado corrige con rate", playing, 9_499, -501,
			&Correction{TargetMs: 10_205, Strategy: Rate, DriftMs: -501, Version: 3},
		},
		{
			"1500 adelantado corrige con rate", playing, 11_500, 1_500,
			&Correction{TargetMs: 10_205, Strategy: Rate, DriftMs: 1_500, Version: 3},
		},
		{
			"más de 2000 corrige con seek", playing, 4_000, -6_000,
			&Correction{TargetMs: 10_205, Strategy: Seek, DriftMs: -6_000, Version: 3},
		},
		{"pausada y alineada", paused, 10_200, 200, nil},
		{
			// En pausa no tiene sentido ajustar velocidad: siempre seek.
			"pausada desfasada corrige con seek", paused, 9_000, -1_000,
			&Correction{TargetMs: 10_000, Strategy: Seek, DriftMs: -1_000, Version: 3},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d, c := Check(tt.state, tt.clientPos, recv, rtt, now)
			if d != tt.wantDrift {
				t.Errorf("drift = %d, want %d", d, tt.wantDrift)
			}
			switch {
			case tt.want == nil && c != nil:
				t.Errorf("no esperaba corrección, got %+v", *c)
			case tt.want != nil && c == nil:
				t.Errorf("esperaba corrección %+v, got nil", *tt.want)
			case tt.want != nil && *c != *tt.want:
				t.Errorf("corrección = %+v, want %+v", *c, *tt.want)
			}
		})
	}
}

func TestCheckNegativeRTTIsIgnored(t *testing.T) {
	s := master.State{Status: master.Playing, PositionMs: 0, UpdatedAtMs: t0, Rate: 1}
	d, c := Check(s, 10_000, t0+10_000, -40, t0+10_000)
	if d != 0 || c != nil {
		t.Errorf("con rtt negativo debe tratarse como 0: drift=%d corr=%v", d, c)
	}
}

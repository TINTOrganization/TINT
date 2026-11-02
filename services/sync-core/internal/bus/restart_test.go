package bus

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
)

// DAT-03: tras reiniciar Redis el bus se vuelve a suscribir solo (sin reiniciar la réplica) y
// lo publicado después sigue llegando; así un REVOKED no se pierde por un corte de Redis.
func TestDeliveryResumesAfterRedisRestart(t *testing.T) {
	mr := miniredis.RunT(t)
	a, gotA := newBus(t, mr)
	b, _ := newBus(t, mr)
	ctx := context.Background()

	if err := a.Subscribe(ctx, "r1"); err != nil {
		t.Fatal(err)
	}
	waitSubscribers(t, mr, "room:r1:sync", 1)
	if err := b.Publish(ctx, "r1", []byte("antes")); err != nil {
		t.Fatal(err)
	}
	if d := recv(t, gotA); d.payload != "antes" {
		t.Fatalf("antes del corte llegó %+v", d)
	}

	mr.Close()
	if err := mr.Restart(); err != nil {
		t.Fatal(err)
	}
	waitSubscribers(t, mr, "room:r1:sync", 1)

	// El cliente de B también vuelve a conectar: se reintenta hasta que publica.
	if err := b.Publish(ctx, "r1", []byte("despues")); err != nil {
		t.Fatalf("publicar tras el reinicio: %v", err)
	}
	if d := recv(t, gotA); d.payload != "despues" {
		t.Fatalf("tras el reinicio llegó %+v", d)
	}
}

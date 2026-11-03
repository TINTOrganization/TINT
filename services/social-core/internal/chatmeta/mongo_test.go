package chatmeta

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
)

// Pruebas contra un MongoDB real: MONGO_TEST_URI=mongodb://localhost:27017 go test ./internal/chatmeta
// Cada prueba usa una base propia y la borra al terminar.
func testStore(t *testing.T, retention time.Duration) (*Store, *mongo.Database) {
	t.Helper()
	uri := os.Getenv("MONGO_TEST_URI")
	if uri == "" {
		t.Skip("MONGO_TEST_URI no definida: se omiten las pruebas con MongoDB real")
	}
	ctx := context.Background()
	name := fmt.Sprintf("chatmeta_test_%d", time.Now().UnixNano())
	s, err := Open(uri, name, retention)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = s.db.Drop(ctx)
		_ = s.Close(ctx)
	})
	return s, s.db
}

func TestEnsureSchemaIsIdempotentAndCreatesIndexes(t *testing.T) {
	s, db := testStore(t, 90*24*time.Hour)
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		if err := s.EnsureSchema(ctx); err != nil {
			t.Fatalf("EnsureSchema #%d: %v", i+1, err)
		}
	}
	cur, err := db.Collection(CollectionName).Indexes().List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var idx []bson.M
	if err := cur.All(ctx, &idx); err != nil {
		t.Fatal(err)
	}
	byName := map[string]bson.M{}
	for _, i := range idx {
		byName[i["name"].(string)] = i
	}
	if _, ok := byName[RoomTimeIndex]; !ok {
		t.Errorf("falta el índice %s: %v", RoomTimeIndex, idx)
	}
	ttl, ok := byName[TTLIndex]
	if !ok {
		t.Fatalf("falta el índice TTL: %v", idx)
	}
	if got := toInt64(ttl["expireAfterSeconds"]); got != int64((90 * 24 * time.Hour).Seconds()) {
		t.Errorf("expireAfterSeconds = %v", ttl["expireAfterSeconds"])
	}
}

func TestEnsureSchemaUpdatesTheRetention(t *testing.T) {
	s, db := testStore(t, 90*24*time.Hour)
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	s.retention = 30 * 24 * time.Hour
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatalf("cambiar la retención no debe fallar: %v", err)
	}
	cur, _ := db.Collection(CollectionName).Indexes().List(ctx)
	var idx []bson.M
	_ = cur.All(ctx, &idx)
	for _, i := range idx {
		if i["name"] == TTLIndex && toInt64(i["expireAfterSeconds"]) != int64((30*24*time.Hour).Seconds()) {
			t.Errorf("expireAfterSeconds = %v", i["expireAfterSeconds"])
		}
	}
}

func TestInsertManyIsIdempotent(t *testing.T) {
	s, db := testStore(t, time.Hour)
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	batch := []Doc{doc("e-1"), doc("e-2")}
	if err := s.InsertMany(ctx, batch); err != nil {
		t.Fatal(err)
	}
	// Reintento tras una caída: el mismo lote más uno nuevo.
	if err := s.InsertMany(ctx, append(batch, doc("e-3"))); err != nil {
		t.Fatalf("un _id repetido debe contar como escrito: %v", err)
	}
	if n, _ := db.Collection(CollectionName).CountDocuments(ctx, bson.M{}); n != 3 {
		t.Errorf("documentos = %d", n)
	}
	var got bson.M
	if err := db.Collection(CollectionName).FindOne(ctx, bson.M{"_id": "e-1"}).Decode(&got); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"text", "nick", "sub"} {
		if _, ok := got[key]; ok {
			t.Errorf("el documento guardado tiene %q", key)
		}
	}
	if got["room_id"] != "r1" || got["status"] != "accepted" {
		t.Errorf("documento = %v", got)
	}
}

func TestValidatorRequiresCoreFieldsAndAcceptsExtras(t *testing.T) {
	s, db := testStore(t, time.Hour)
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	coll := db.Collection(CollectionName)
	extra := bson.M{"_id": "x-1", "room_id": "r1", "author": "a", "status": "accepted", "length": 3, "received_at": t0, "campo_nuevo": true}
	if _, err := coll.InsertOne(ctx, extra); err != nil {
		t.Errorf("un campo extra debe aceptarse (DAT-02 AC3): %v", err)
	}
	missing := bson.M{"_id": "x-2", "author": "a", "status": "accepted", "length": 3, "received_at": t0}
	if _, err := coll.InsertOne(ctx, missing); err == nil {
		t.Error("sin room_id debe rechazarse")
	}
	wrongType := bson.M{"_id": "x-3", "room_id": "r1", "author": "a", "status": "accepted", "length": "tres", "received_at": t0}
	if _, err := coll.InsertOne(ctx, wrongType); err == nil {
		t.Error("length no numérico debe rechazarse")
	}
}

func TestRoomAndTimeQueryUsesTheIndex(t *testing.T) {
	s, db := testStore(t, time.Hour)
	ctx := context.Background()
	if err := s.EnsureSchema(ctx); err != nil {
		t.Fatal(err)
	}
	var batch []Doc
	for i := 0; i < 50; i++ {
		d := doc(fmt.Sprintf("e-%d", i))
		d.RoomID = fmt.Sprintf("r%d", i%5)
		batch = append(batch, d)
	}
	if err := s.InsertMany(ctx, batch); err != nil {
		t.Fatal(err)
	}
	filter := bson.D{{Key: "room_id", Value: "r1"}, {Key: "received_at", Value: bson.D{{Key: "$gte", Value: t0.Add(-time.Hour)}, {Key: "$lt", Value: t0.Add(time.Hour)}}}}
	var plan bson.M
	cmd := bson.D{{Key: "explain", Value: bson.D{{Key: "find", Value: CollectionName}, {Key: "filter", Value: filter}}}, {Key: "verbosity", Value: "queryPlanner"}}
	if err := db.RunCommand(ctx, cmd).Decode(&plan); err != nil {
		t.Fatal(err)
	}
	if !usesIndex(plan, RoomTimeIndex) {
		t.Errorf("la consulta por sala y tiempo no usa %s: %v", RoomTimeIndex, plan["queryPlanner"])
	}
}

// usesIndex busca un IXSCAN con ese índice en el plan ganador.
func usesIndex(v any, name string) bool {
	switch x := v.(type) {
	case bson.M:
		if x["stage"] == "IXSCAN" && x["indexName"] == name {
			return true
		}
		for k, child := range x {
			if k == "rejectedPlans" {
				continue
			}
			if usesIndex(child, name) {
				return true
			}
		}
	case bson.D:
		m := bson.M{}
		for _, e := range x {
			m[e.Key] = e.Value
		}
		return usesIndex(m, name)
	case bson.A:
		for _, child := range x {
			if usesIndex(child, name) {
				return true
			}
		}
	}
	return false
}

func toInt64(v any) int64 {
	switch n := v.(type) {
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	}
	return -1
}

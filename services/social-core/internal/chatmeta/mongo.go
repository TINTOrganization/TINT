package chatmeta

import (
	"context"
	"errors"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const (
	// DatabaseName es la base de social-core en MongoDB.
	DatabaseName = "social"
	// CollectionName guarda un documento por intento de envío.
	CollectionName = "chat_message_meta"
	// RoomTimeIndex sirve la consulta por sala y rango de tiempo.
	RoomTimeIndex = "room_id_received_at"
	// TTLIndex borra los documentos al vencer la retención.
	TTLIndex = "received_at_ttl"

	codeDuplicateKey      = 11000
	codeNamespaceExists   = 48
	codeIndexOptsConflict = 85
)

// Store escribe en chat_message_meta.
type Store struct {
	client    *mongo.Client
	db        *mongo.Database
	retention time.Duration
}

// Open prepara el cliente sin exigir que MongoDB responda: el chat debe
// arrancar aunque MongoDB esté caído (el escritor reintenta).
func Open(uri, database string, retention time.Duration) (*Store, error) {
	client, err := mongo.Connect(options.Client().ApplyURI(uri).
		SetServerSelectionTimeout(5 * time.Second).SetTimeout(10 * time.Second))
	if err != nil {
		return nil, err
	}
	return &Store{client: client, db: client.Database(database), retention: retention}, nil
}

// Close cierra el cliente.
func (s *Store) Close(ctx context.Context) error { return s.client.Disconnect(ctx) }

// validator exige los campos básicos y admite campos extra (DAT-02 AC3).
func validator() bson.M {
	return bson.M{"$jsonSchema": bson.M{
		"bsonType": "object",
		"required": bson.A{"_id", "room_id", "author", "status", "length", "received_at"},
		"properties": bson.M{
			"_id":         bson.M{"bsonType": "string"},
			"room_id":     bson.M{"bsonType": "string"},
			"author":      bson.M{"bsonType": "string"},
			"status":      bson.M{"enum": bson.A{string(StatusAccepted), string(StatusRejected)}},
			"length":      bson.M{"bsonType": bson.A{"int", "long"}, "minimum": 0},
			"received_at": bson.M{"bsonType": "date"},
		},
	}}
}

// EnsureSchema crea (o actualiza) la colección con su validador y sus
// índices. Es idempotente; si cambió la retención, ajusta el TTL.
func (s *Store) EnsureSchema(ctx context.Context) error {
	err := s.db.CreateCollection(ctx, CollectionName, options.CreateCollection().
		SetValidator(validator()).SetValidationLevel("moderate"))
	if hasCode(err, codeNamespaceExists) {
		err = s.db.RunCommand(ctx, bson.D{
			{Key: "collMod", Value: CollectionName},
			{Key: "validator", Value: validator()},
			{Key: "validationLevel", Value: "moderate"},
		}).Err()
	}
	if err != nil {
		return err
	}
	coll := s.db.Collection(CollectionName)
	if _, err := coll.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "room_id", Value: 1}, {Key: "received_at", Value: 1}},
		Options: options.Index().SetName(RoomTimeIndex),
	}); err != nil {
		return err
	}
	ttl := int32(s.retention / time.Second)
	_, err = coll.Indexes().CreateOne(ctx, mongo.IndexModel{
		Keys:    bson.D{{Key: "received_at", Value: 1}},
		Options: options.Index().SetName(TTLIndex).SetExpireAfterSeconds(ttl),
	})
	if hasCode(err, codeIndexOptsConflict) {
		return s.db.RunCommand(ctx, bson.D{
			{Key: "collMod", Value: CollectionName},
			{Key: "index", Value: bson.D{{Key: "name", Value: TTLIndex}, {Key: "expireAfterSeconds", Value: ttl}}},
		}).Err()
	}
	return err
}

// InsertMany inserta sin orden; un _id repetido (un lote reintentado) cuenta
// como escrito.
func (s *Store) InsertMany(ctx context.Context, docs []Doc) error {
	_, err := s.db.Collection(CollectionName).InsertMany(ctx, docs, options.InsertMany().SetOrdered(false))
	if err == nil {
		return nil
	}
	var bulk mongo.BulkWriteException
	if errors.As(err, &bulk) && bulk.WriteConcernError == nil && len(bulk.WriteErrors) > 0 {
		for _, we := range bulk.WriteErrors {
			if we.Code != codeDuplicateKey {
				return err
			}
		}
		return nil
	}
	return err
}

func hasCode(err error, code int) bool {
	if err == nil {
		return false
	}
	var se mongo.ServerError
	return errors.As(err, &se) && se.HasErrorCode(code)
}

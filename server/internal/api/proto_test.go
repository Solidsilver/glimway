package api

import (
	"bytes"
	"log"
	"math"
	"net/http/httptest"
	"strings"
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/structpb"
)

func TestWriteProtoRejectsNonFinite(t *testing.T) {
	for _, number := range []float64{math.NaN(), math.Inf(1), math.Inf(-1)} {
		for _, message := range []proto.Message{
			&contract.CalendarResponse{StartsAt: number},
			&contract.PresenceRoom{Players: []*contract.PresencePlayer{{Pos: &contract.PresencePosition{X: proto.Float64(number)}}}},
			&contract.PresenceAvatar{Equipped: map[string]*structpb.Value{"weapon": structpb.NewNumberValue(number)}},
			&structpb.ListValue{Values: []*structpb.Value{structpb.NewNumberValue(number)}},
		} {
			w := httptest.NewRecorder()
			writeProto(w, 200, message)
			if w.Code != 500 || strings.Contains(w.Body.String(), "Infinity") || strings.Contains(w.Body.String(), "NaN") {
				t.Fatalf("%T: %d %s", message, w.Code, w.Body)
			}
		}
	}
}
func TestWriteProtoRejectsInvalidUTF8(t *testing.T) {
	w := httptest.NewRecorder()
	writeProto(w, 200, &contract.CalendarResponse{Wick: string([]byte{0xff})})
	if w.Code != 500 {
		t.Fatalf("invalid UTF-8: %d %s", w.Code, w.Body)
	}
}
func TestMissingErrorCodeLogsAndFails(t *testing.T) {
	var logged bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&logged)
	defer log.SetOutput(previous)
	defer func() {
		if recover() == nil {
			t.Error("missing enum entry did not fail")
		}
		if !strings.Contains(logged.String(), `"uncatalogued-refusal"`) {
			t.Errorf("missing diagnostic: %s", logged.String())
		}
	}()
	errorCodeProto("uncatalogued-refusal")
}

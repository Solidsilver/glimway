package api

import (
	"encoding/json"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"io"
	"net/http"
)

// decodeOp is strict: old progress uploads and unknown payload fields are
// refused rather than silently discarded. Domain checks stay in each handler.
func decodeOp(w http.ResponseWriter, r *http.Request, message proto.Message) error {
	r.Body = http.MaxBytesReader(w, r.Body, 200000)
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return fail(400, "invalid-json")
	}
	if message.ProtoReflect().Descriptor().Fields().ByName("op") != nil {
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) == nil && fields["op"] == nil && (fields["lease"] != nil || fields["progress"] != nil || fields["baseRev"] != nil) {
			return fail(404, "not-found")
		}
	}
	if err = strictRequestJSON(raw, message.ProtoReflect().Descriptor()); err != nil {
		return fail(400, "invalid-json")
	}
	if err = protojson.Unmarshal(raw, message); err != nil {
		return fail(400, "invalid-json")
	}
	if err = validatePayload(message.ProtoReflect()); err != nil {
		return fail(400, "invalid-json")
	}
	if err = finiteProto(message.ProtoReflect()); err != nil {
		return fail(400, "invalid-json")
	}
	return nil
}

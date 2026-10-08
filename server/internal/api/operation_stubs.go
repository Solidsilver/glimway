package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
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
func notImplemented(context.Context, *sql.Tx, *store.Snapshot, int64) (any, error) {
	return nil, fail(409, "not-implemented")
}

// Lane B replaces the six non-Wilds callbacks (D has replaced its own).
func (a *Server) operationStub(w http.ResponseWriter, r *http.Request) error {
	var request proto.Message
	var op *contract.OpHeader
	var where *contract.Where
	switch r.URL.Path {
	case "/api/spend":
		m := &contract.SpendRequest{}
		if err := decodeOp(w, r, m); err != nil {
			return err
		}
		request, op, where = m, m.Op, m.Where
	case "/api/quest/step":
		m := &contract.QuestStepRequest{}
		if err := decodeOp(w, r, m); err != nil {
			return err
		}
		request = m
		op = m.Op
		where = m.Where
	case "/api/story/mark":
		m := &contract.MarkRequest{}
		if err := decodeOp(w, r, m); err != nil {
			return err
		}
		request = m
		op = m.Op
		where = m.Where
	case "/api/papers/take":
		m := &contract.TakePaperRequest{}
		if err := decodeOp(w, r, m); err != nil {
			return err
		}
		request = m
		op = m.Op
		where = m.Where
	case "/api/fall":
		m := &contract.FallRequest{}
		if err := decodeOp(w, r, m); err != nil {
			return err
		}
		request = m
		op = m.Op
		where = m.Where
	case "/api/report", "/api/profile":
		var lease string
		if r.URL.Path == "/api/report" {
			m := &contract.ReportRequest{}
			if err := decodeOp(w, r, m); err != nil {
				return err
			}
			lease = m.Lease
		} else {
			m := &contract.ProfileReport{}
			if err := decodeOp(w, r, m); err != nil {
				return err
			}
			lease = m.Lease
		}
		tx, s, _, err := a.begin(r)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		if err = a.requireLease(r.Context(), tx, s, lease); err != nil {
			return err
		}
		state, err := a.Config.State.PlayerState(r.Context(), tx, s)
		if err != nil {
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		writeRefusal(w, 409, "not-implemented", state)
		return nil
	}
	return a.keyedOp(w, r, op, where, request, notImplemented)
}

// The intermediate lane still compiles/runs existing domain handlers until B/D
// replace them. A v3 request is routed to its declared stub, never an upload.
func (a *Server) migratingOperation(w http.ResponseWriter, r *http.Request, old func(http.ResponseWriter, *http.Request) error) error {
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 200000))
	if err != nil {
		return fail(400, "invalid-json")
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal(raw, &fields); err != nil {
		return fail(400, "invalid-json")
	}
	r.Body = io.NopCloser(bytes.NewReader(raw))
	if fields["op"] != nil {
		return a.operationStub(w, r)
	}
	return old(w, r)
}

package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
	"math"
	"net/http"
)

func (a *Server) requireLease(ctx context.Context, tx *sql.Tx, s store.Snapshot, lease string) error {
	if lease == "" || !s.LeaseID.Valid || lease != s.LeaseID.String {
		return fail(409, "superseded")
	}
	_, err := tx.ExecContext(ctx, "UPDATE players SET lease_seen_at=? WHERE account_id=?", a.Config.Now().Unix(), s.AccountID)
	return err
}

// keyedOp keeps authentication outside gameplay's savepoint. A game refusal
// rolls back place, rewards and all callback writes, then carries current state.
// apply returns a typed proto result or an existing domain's JSON result.
func (a *Server) keyedOp(w http.ResponseWriter, r *http.Request, op *contract.OpHeader, where *contract.Where, request any, apply func(context.Context, *sql.Tx, *store.Snapshot, int64) (any, error), afterCommit ...func()) error {
	return a.keyedOpFinalized(w, r, op, where, request, apply, nil, afterCommit...)
}

// finalize is supplied by operations whose result includes final causal state.
func (a *Server) keyedOpFinalized(w http.ResponseWriter, r *http.Request, op *contract.OpHeader, where *contract.Where, request any, apply func(context.Context, *sql.Tx, *store.Snapshot, int64) (any, error), finalize func(*contract.PlayerState, any), afterCommit ...func()) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	clock := a.Config.Now()
	ctx, now := r.Context(), clock.Unix()
	if op == nil {
		return fail(400, "invalid-json")
	}
	if err = a.requireLease(ctx, tx, s, op.Lease); err != nil {
		return err
	}
	refuse := func(err error) error {
		var f *failure
		if !errors.As(err, &f) || f.status < 400 || f.status >= 500 {
			return err
		}
		state, e := a.Config.State.PlayerState(ctx, tx, s)
		if e != nil {
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
		writeRefusal(w, f.status, f.code, state)
		return nil
	}
	hash, prior, err := opIdem(ctx, tx, s.AccountID, r.URL.Path, op.Key, request, now)
	if err != nil {
		return refuse(err)
	}
	if prior != nil {
		state, e := a.Config.State.PlayerState(ctx, tx, s)
		if e != nil {
			return e
		}
		if prior.Refused != "" {
			if e = tx.Commit(); e != nil {
				return e
			}
			writeRefusal(w, prior.Status, prior.Refused, state)
			return nil
		}
		result, e := replayResult(prior, request)
		if e != nil {
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
		return writeOpResult(w, state, result)
	}
	// A supplied barrier is checked before this operation refreshes place.
	// B additionally requires a non-nil barrier on vitals-dependent operations.
	if op.Report != nil {
		if err = requireReportBarrier(ctx, tx, s.AccountID, op.Report); err != nil {
			return refuse(err)
		}
	}
	if where == nil || !validArea(where.Area) || !finiteWhere(where) {
		return refuse(fail(409, "invalid-position"))
	}
	if _, err = tx.ExecContext(ctx, "SAVEPOINT gameplay"); err != nil {
		return err
	}
	s.PlaceWritten = true
	s.State.Area = where.Area
	s.State.Position = rulesPosition(where)
	if a.Config.Placement != nil {
		err = a.Config.Placement.Record(ctx, tx, &s, where, now)
	}
	var result any
	if err == nil {
		result, err = apply(ctx, tx, &s, now)
	}
	if err == nil {
		err = settleSlots(ctx, tx, &s)
	}
	if err == nil {
		s.VitalsAt = float64(clock.UnixNano()) / 1e9
		err = a.Config.State.Persist(ctx, tx, &s, now)
	}
	if err != nil {
		if _, e := tx.ExecContext(ctx, "ROLLBACK TO gameplay"); e != nil {
			return e
		}
		s, errLoad := a.Config.State.Load(ctx, tx, s.AccountID)
		if errLoad != nil {
			return errLoad
		}
		// The closure uses the restored snapshot, never the callback's partial state.
		var f *failure
		if !errors.As(err, &f) || f.status < 400 || f.status >= 500 {
			return err
		}
		if terminalRefusal(f) {
			if e := saveRefusedOp(ctx, tx, s.AccountID, r.URL.Path, op.Key, hash, f, s.Version, now); e != nil {
				return e
			}
			if e := savePayload(tx, s.AccountID, r.URL.Path, op.Key, request); e != nil {
				return e
			}
		}
		state, e := a.Config.State.PlayerState(ctx, tx, s)
		if e != nil {
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
		writeRefusal(w, f.status, f.code, state)
		return nil
	}
	state, err := a.Config.State.PlayerState(ctx, tx, s)
	if err != nil {
		return err
	}
	if finalize != nil {
		finalize(state, result)
	}
	if err = saveOpIdem(ctx, tx, s.AccountID, r.URL.Path, op.Key, hash, result, s.Version, now); err != nil {
		return err
	}
	if err = savePayload(tx, s.AccountID, r.URL.Path, op.Key, request); err != nil {
		return err
	}
	// Validate response before committing; invalid output must not commit a reward.
	if _, err = opResultBytes(state, result); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	for _, notify := range afterCommit {
		notify()
	}
	return writeOpResult(w, state, result)
}

func finiteWhere(where *contract.Where) bool {
	return !math.IsNaN(where.X) && !math.IsNaN(where.Y) && !math.IsInf(where.X, 0) && !math.IsInf(where.Y, 0) && math.Abs(where.X) <= 1e6 && math.Abs(where.Y) <= 1e6
}

// All typed operation results must appear exactly once in Envelope.result.
func typedEnvelope(state *contract.PlayerState, result proto.Message) (*contract.Envelope, error) {
	e := &contract.Envelope{State: state}
	fields := e.ProtoReflect().Descriptor().Oneofs().ByName("result").Fields()
	for i := 0; i < fields.Len(); i++ {
		f := fields.Get(i)
		if f.Message().FullName() == result.ProtoReflect().Descriptor().FullName() {
			e.ProtoReflect().Set(f, protoreflect.ValueOfMessage(result.ProtoReflect()))
			return e, nil
		}
	}
	return nil, errors.New("operation result missing from envelope")
}

func opResultBytes(state *contract.PlayerState, result any) ([]byte, error) {
	if message, ok := result.(proto.Message); ok {
		envelope, err := typedEnvelope(state, message)
		if err != nil {
			return nil, err
		}
		if err = finiteProto(envelope.ProtoReflect()); err != nil {
			return nil, err
		}
		return (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(envelope)
	}
	return mixedBytes(state, result)
}
func writeOpResult(w http.ResponseWriter, state *contract.PlayerState, result any) error {
	raw, err := opResultBytes(state, result)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, err = w.Write(append(raw, '\n'))
	return err
}
func mixedBytes(state *contract.PlayerState, result any) ([]byte, error) {
	if state == nil {
		return nil, errors.New("missing player state")
	}
	if err := finiteProto(state.ProtoReflect()); err != nil {
		return nil, err
	}
	raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(state)
	if err != nil {
		return nil, err
	}
	return json.Marshal(struct {
		State  json.RawMessage `json:"state"`
		Result any             `json:"result"`
	}{raw, result})
}
func writeMixed(w http.ResponseWriter, status int, state *contract.PlayerState, result any) {
	raw, err := mixedBytes(state, result)
	if err != nil {
		problem(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(append(raw, '\n'))
}
func writeRefusal(w http.ResponseWriter, status int, code string, state *contract.PlayerState) {
	writeProto(w, status, &contract.Refusal{Error: &contract.ErrorDetail{Code: errorCodeWire(errorCodeProto(code))}, State: state})
}

func rulesPosition(w *contract.Where) rules.Position { return rules.Position{X: w.X, Y: w.Y} }

// B calls this before operations that read stored vitals. A missing/old barrier
// is retryable after flushing a report, never grounds to discard an outbox head.
func requireReportBarrier(ctx context.Context, tx *sql.Tx, account string, barrier *contract.ReportBarrier) error {
	if barrier == nil || barrier.Seq < 1 || !safeCounter(barrier.Seq) || !validPayloadID(barrier.Client) || !validPayloadID(barrier.Generation) {
		return fail(409, "report-required")
	}
	var client, generation string
	var seq, basis, setVersion float64
	err := tx.QueryRowContext(ctx, "SELECT report_client,report_generation,report_seq,report_basis,vitals_set_version FROM player_vitals WHERE account_id=?", account).Scan(&client, &generation, &seq, &basis, &setVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return fail(409, "report-required")
	}
	if err != nil {
		return err
	}
	if client != barrier.Client || generation != barrier.Generation || seq < barrier.Seq || basis < setVersion {
		return fail(409, "report-required")
	}
	return nil
}

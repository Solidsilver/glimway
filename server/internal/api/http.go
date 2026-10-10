package api

import (
	"encoding/json"
	"errors"
	"google.golang.org/protobuf/proto"
	"io"
	"net/http"
	"net/url"
)

type failure struct {
	status int
	code   string
}

func (e *failure) Error() string { return e.code }

func fail(status int, code string) error { return &failure{status, code} }

// heldRefusal is a refusal whose writes stand (review finding 16). The keyed
// pipeline's savepoint rolls a refusal's effects back; 5.4's "either way the
// cast closes" needs one that does not, so a settle whose keep is refused
// still releases the catch and the line. Everything the operation wrote
// since the savepoint stands with it — the request's `where` placement write
// included (harmless here: the settle's place is where the hero stands).
// Only an operation's own apply raises one, and only after writing everything
// the refusal must keep.
type heldRefusal struct{ err error }

func (e *heldRefusal) Error() string { return e.err.Error() }
func (e *heldRefusal) Unwrap() error { return e.err }

// held marks a refusal as one whose writes stand.
func held(err error) error { return &heldRefusal{err} }

func isHeld(err error) bool {
	var h *heldRefusal
	return errors.As(err, &h)
}

func problem(w http.ResponseWriter, err error) {
	var f *failure
	if !errors.As(err, &f) {
		f = &failure{500, "internal"}
	}
	write(w, f.status, map[string]any{"error": map[string]string{"code": errorCodeWire(errorCodeProto(f.code))}})
}

func write(w http.ResponseWriter, status int, v any) {
	if message, ok := v.(proto.Message); ok {
		writeProto(w, status, message)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 200000)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return fail(400, "invalid-json")
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		return fail(400, "invalid-json")
	}
	return nil
}

// Browser WebSockets require an Origin; HTTP callers retain the established
// optional-Origin contract. Do not trust a caller-supplied forwarded Host.
func sameOrigin(r *http.Request, required bool) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	raw := r.Header.Get("Origin")
	if raw == "" {
		return !required
	}
	u, err := url.Parse(raw)
	return err == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}

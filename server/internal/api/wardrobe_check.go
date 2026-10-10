package api

import (
	"context"
	"database/sql"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
	"net/http"
)

// wardrobeCheck (POST /api/wardrobe/check, "Check for new gear", design 4.3)
// is the wardrobe's own token-carrying request: one server read of
// items.gear.owned, written to player_gear. It is handled like the top-up's
// first half —
//
//   - the token comes off the request first and is dropped after the call;
//   - it is not on keyedOp, so nothing stores or serves the payload (review
//     finding 9); it needs the lease but carries no idempotency, because
//     running it twice only reads twice;
//   - the call runs outside every transaction (the store is one connection),
//     on the sign-in budget through withHabitica, and a refused token counts
//     as a failed proof;
//   - a short transaction then writes the list.
//
// The list is the server's own read, never a browser report: a forged
// /api/profile can't own gear (4.3).
func (a *Server) wardrobeCheck(w http.ResponseWriter, r *http.Request) error {
	var req contract.WardrobeCheckRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	token := req.Token
	req.Token = ""
	if token == "" || len(token) > 512 {
		return fail(400, "invalid-credentials")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = a.requireLease(r.Context(), tx, s, req.Lease); err != nil {
		return a.refuseOp(w, r, tx, s, err)
	}
	if s.ProfileSource != "habitica" {
		return a.refuseOp(w, r, tx, s, fail(409, "needs-habitica"))
	}
	subject, err := store.HabiticaSubject(r.Context(), tx, s.AccountID)
	if err != nil {
		return err
	}
	// Nothing is written here, and the call below must not run inside a
	// transaction: commit the short one and open another after the read.
	if err = tx.Commit(); err != nil {
		return err
	}
	account := s.AccountID
	now := a.Config.Now().Unix()
	result := &contract.WardrobeCheckResult{Owned: []string{}}
	err = a.withHabitica(r, subject, func(b habiticaBudget) error {
		call, stop := context.WithTimeout(r.Context(), habiticaCallTime)
		owned, e := a.Habitica.OwnedGear(call, subject, token, b.Allow)
		token = ""
		stop()
		if e != nil {
			if habiticaNote(e) == "habitica-auth" {
				b.FailedProof()
			}
			return habiticaFailure(e)
		}
		return a.withTx(r.Context(), func(tx *sql.Tx) error {
			before, _, err := store.PlayerGear(r.Context(), tx, account)
			if err != nil {
				return err
			}
			seen := map[string]bool{}
			for _, key := range before {
				seen[key] = true
			}
			for _, key := range owned {
				if !seen[key] {
					result.NewPieces++
				}
			}
			if err = store.WritePlayerGear(r.Context(), tx, account, owned, now); err != nil {
				return err
			}
			result.Owned, result.CheckedAt = owned, float64(now)
			return nil
		})
	})
	if err != nil {
		var refused *budgetRefusal
		if errors.As(err, &refused) {
			err = budgetFailure(w, err)
		}
		return a.refuseWithState(w, r, err)
	}
	return a.answerWithState(w, r, result)
}

// answerWithState writes an operation's result in the envelope's own case,
// with the account's current state, from a fresh short transaction (the
// handler's own is gone before the upstream call, by design).
func (a *Server) answerWithState(w http.ResponseWriter, r *http.Request, result proto.Message) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	state, err := a.Config.State.PlayerState(r.Context(), tx, s)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	return writeOpResult(w, state, result)
}

// refuseWithState answers a refusal with the account's current state, from a
// fresh short transaction: the refusals that come after the handler's own
// transaction is gone (a refused token, a busy budget).
func (a *Server) refuseWithState(w http.ResponseWriter, r *http.Request, err error) error {
	var f *failure
	if !errors.As(err, &f) {
		return err
	}
	tx, s, _, e := a.begin(r)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	return a.refuseOp(w, r, tx, s, err)
}

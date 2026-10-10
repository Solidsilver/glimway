package api

import (
	"errors"
	"math"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"
)

// The one way a request that calls Habitica spends the upstream budget
// (login.go:41-59, extracted as the 0.6 cleanup's step 0 seam, review
// finding 10). A sign-in, a purse top-up and the wardrobe's gear check all
// carry a token upstream, and all three spend the same four limits:
// per IP, per-user proofs, a concurrency slot, and the shared per-minute
// budget every call checks. The refusals are the sign-in's own words —
// login-rate-limited, login-user-rate-limited and login-busy — and they
// come before anything is written.

// habiticaBudget is what fn gets: the gate every upstream call checks
// against the shared budget, and the way a rejected identity proof (a wrong
// token) is counted as a wrong sign-in token is. The top-up's worker runs
// past fn's answer and marks its own proof failures through this.
type habiticaBudget struct {
	Allow       func() bool
	FailedProof func()
}

// budgetRefusal is one of the three budget refusals with the wait that goes
// with it on the wire (Retry-After). Handlers turn it into a failure with
// budgetFailure(w, err).
type budgetRefusal struct {
	code  string
	retry time.Duration
}

func (e *budgetRefusal) Error() string { return e.code }

// budgetFailure writes the refusal's Retry-After header and hands back the
// coded failure. Any other error passes through untouched.
func budgetFailure(w http.ResponseWriter, err error) error {
	var b *budgetRefusal
	if errors.As(err, &b) {
		w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(b.retry.Seconds())))))
		return fail(429, b.code)
	}
	return err
}

// withHabitica spends the shared upstream budget around fn. The party's own,
// smaller share is only for sign-ins a party could admit; every other
// token-carrying request (a top-up, a gear check) spends the global one.
func (a *Server) withHabitica(r *http.Request, userID string, fn func(habiticaBudget) error) error {
	return a.withHabiticaBudget(r, userID, a.loginGlobal, fn)
}

func (a *Server) withHabiticaBudget(r *http.Request, userID string, budget *loginLimiter, fn func(habiticaBudget) error) error {
	if !a.loginLimit.allow(a.clientIP(r), a.Config.Now()) {
		return &budgetRefusal{"login-rate-limited", a.Config.LoginWindow}
	}
	finishProof, retry, ok := a.loginProofs.begin(userID, a.Config.Now())
	if !ok {
		return &budgetRefusal{"login-user-rate-limited", retry}
	}
	failed := &atomic.Bool{}
	defer func() { finishProof(failed.Load()) }()
	select {
	case a.loginSlots <- struct{}{}:
		defer func() { <-a.loginSlots }()
	default:
		return &budgetRefusal{"login-busy", time.Second}
	}
	err := fn(habiticaBudget{
		Allow:       func() bool { return budget.allow("global", a.Config.Now()) },
		FailedProof: func() { failed.Store(true) },
	})
	// A refusal for a wrong token is a rejected identity proof, as it is at
	// sign-in. The caller's own wording is kept.
	var f *failure
	if errors.As(err, &f) && f.code == "habitica-auth" {
		failed.Store(true)
	}
	return err
}

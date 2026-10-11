package api

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"fmt"
	"modernc.org/sqlite"
	"net"
	"net/http"
)

// Error strings can contain upstream credentials or untrusted request values.
// Log only Go error types and known sentinel/database codes, never raw text.
func (a *Server) logUnexpected(route string, err error) {
	a.Config.Logger.Printf("unexpected route=%s error_type=%T diagnostic=%s", route, err, diagnostic(err))
}

// logUpstream records why an upstream call failed before it is answered as
// a 502, with the same type-only diagnostic: never the error text, a token
// or a body.
func (a *Server) logUpstream(w http.ResponseWriter, err error) {
	route := "unknown"
	if observed, ok := w.(*statusWriter); ok && observed.route != "" {
		route = observed.route
	}
	a.Config.Logger.Printf("upstream route=%s error_type=%T diagnostic=%s", route, err, diagnostic(err))
}

func diagnostic(err error) string {
	var database *sqlite.Error
	var dns *net.DNSError
	var certificate *tls.CertificateVerificationError
	var timeout net.Error
	switch {
	case errors.As(err, &database):
		return fmt.Sprintf("sqlite-code-%d", database.Code())
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline-exceeded"
	case errors.Is(err, context.Canceled):
		return "canceled"
	case errors.Is(err, sql.ErrNoRows):
		return "no-rows"
	case errors.Is(err, sql.ErrTxDone):
		return "transaction-done"
	case errors.As(err, &dns):
		return "dns"
	case errors.As(err, &certificate):
		return "tls-certificate"
	case errors.As(err, &timeout) && timeout.Timeout():
		return "timeout"
	}
	return "unexpected"
}

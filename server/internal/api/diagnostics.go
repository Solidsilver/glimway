package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"modernc.org/sqlite"
)

// Error strings can contain upstream credentials or untrusted request values.
// Log only Go error types and known sentinel/database codes, never raw text.
func (a *Server) logUnexpected(route string, err error) {
	detail := "unexpected"
	var database *sqlite.Error
	switch {
	case errors.As(err, &database):
		detail = fmt.Sprintf("sqlite-code-%d", database.Code())
	case errors.Is(err, context.DeadlineExceeded):
		detail = "deadline-exceeded"
	case errors.Is(err, context.Canceled):
		detail = "canceled"
	case errors.Is(err, sql.ErrNoRows):
		detail = "no-rows"
	case errors.Is(err, sql.ErrTxDone):
		detail = "transaction-done"
	}
	a.Config.Logger.Printf("unexpected route=%s error_type=%T diagnostic=%s", route, err, detail)
}

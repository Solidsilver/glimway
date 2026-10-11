package chunks

import (
	"context"
	"time"
)

type readTimeKey struct{}

// WithReadTime binds stored chunk lifetime checks to the operation/read clock.
func WithReadTime(ctx context.Context, now time.Time) context.Context {
	return context.WithValue(ctx, readTimeKey{}, now)
}
func ReadTime(ctx context.Context) (time.Time, bool) {
	switch clock := ctx.Value(readTimeKey{}).(type) {
	case time.Time:
		return clock, true
	case func() time.Time:
		return clock(), true
	default:
		return time.Time{}, false
	}
}

// WithReadClock captures time on first use, after a transaction can acquire its lock.
func WithReadClock(ctx context.Context, clock func() time.Time) context.Context {
	return context.WithValue(ctx, readTimeKey{}, clock)
}

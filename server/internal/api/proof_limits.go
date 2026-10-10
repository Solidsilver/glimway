package api

import (
	"sync"
	"time"
)

const proofFailureLimit = 5
const proofFailureWindow = 15 * time.Minute
const proofBucketLimit = 4096

type proofBucket struct {
	start              time.Time
	failures, inflight int
}
type proofLimiter struct {
	mu      sync.Mutex
	buckets map[string]*proofBucket
}

// Reserve a possible failed proof before taking a global/concurrency slot.
// Inflight reservations prevent a burst from overshooting the per-user quota.
// Only a rejected upstream identity proof consumes it; success, busy, network
// failures, and global/upstream rate limits release the reservation unchanged.
func (l *proofLimiter) begin(id string, now time.Time) (func(bool), time.Duration, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[id]
	if b != nil && b.inflight == 0 && now.Sub(b.start) >= proofFailureWindow {
		delete(l.buckets, id)
		b = nil
	}
	if b == nil {
		if len(l.buckets) >= proofBucketLimit {
			oldest := ""
			var at time.Time
			for k, v := range l.buckets {
				if v.inflight == 0 && (oldest == "" || v.start.Before(at)) {
					oldest = k
					at = v.start
				}
			}
			if oldest == "" {
				return nil, time.Second, false
			}
			delete(l.buckets, oldest)
		}
		b = &proofBucket{start: now}
		l.buckets[id] = b
	}
	if b.failures >= proofFailureLimit {
		return nil, max(time.Second, proofFailureWindow-now.Sub(b.start)), false
	}
	if b.failures+b.inflight >= proofFailureLimit {
		return nil, time.Second, false
	}
	b.inflight++
	var once sync.Once
	return func(failed bool) {
		once.Do(func() {
			l.mu.Lock()
			defer l.mu.Unlock()
			b.inflight--
			if failed {
				b.failures++
			}
			if b.inflight == 0 && b.failures == 0 {
				delete(l.buckets, id)
			}
		})
	}, 0, true
}

// fail records one rejected upstream identity proof directly (finding 7).
// The top-up's worker can find a wrong token long after the request that
// spent the budget is gone — its reservation is already released as "not
// failed" — so the worker marks the failure on the limiter itself. The
// window and the limit are the same ones `begin` enforces.
func (l *proofLimiter) fail(id string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[id]
	if b != nil && b.inflight == 0 && now.Sub(b.start) >= proofFailureWindow {
		delete(l.buckets, id)
		b = nil
	}
	if b == nil {
		if len(l.buckets) >= proofBucketLimit {
			return
		}
		b = &proofBucket{start: now}
		l.buckets[id] = b
	}
	b.failures++
}

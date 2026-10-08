//go:build dev

package main

import (
	"flag"
	"fmt"
	"strconv"
	"time"
)

func devClock(f *flag.FlagSet) func() (func() time.Time, error) {
	stamp := f.String("dev-clock", "", "Start clock at Unix seconds, advancing normally (dev builds only)")
	return func() (func() time.Time, error) {
		if *stamp == "" {
			return time.Now, nil
		}
		n, err := strconv.ParseInt(*stamp, 10, 64)
		if err != nil {
			return nil, fmt.Errorf("invalid dev-clock: %w", err)
		}
		start, boot := time.Unix(n, 0), time.Now()
		return func() time.Time { return start.Add(time.Since(boot)) }, nil
	}
}

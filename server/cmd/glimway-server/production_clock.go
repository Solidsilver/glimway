//go:build !dev

package main

import (
	"flag"
	"time"
)

func devClock(*flag.FlagSet) func() (func() time.Time, error) {
	return func() (func() time.Time, error) { return time.Now, nil }
}

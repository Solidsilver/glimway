//go:build !dev

package main

import "flag"

// Production builds have no -dev-clock flag and no clock route: the real clock, and the handler as it is.
func devClock(*flag.FlagSet) func(configured bool) (clockSetup, error) {
	return func(bool) (clockSetup, error) { return realClock(), nil }
}

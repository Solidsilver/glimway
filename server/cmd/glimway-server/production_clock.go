//go:build !dev

package main

import "flag"

// Production builds have no -dev-clock flag and no clock route: the real clock, and the handler as it is.
func devClock(*flag.FlagSet) func() (clockSetup, error) {
	return func() (clockSetup, error) { return realClock(), nil }
}

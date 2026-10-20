//go:build !(linux || darwin || freebsd)

package worldlab

import "os/exec"

func ownGroup(*exec.Cmd) {}

func lower(int, int) {}

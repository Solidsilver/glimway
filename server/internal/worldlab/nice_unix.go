//go:build linux || darwin || freebsd

package worldlab

import (
	"os/exec"
	"syscall"
)

// ownGroup starts the worker in a process group of its own, so lower
// reaches every thread it has (Linux keeps a nice value per thread, and
// the Go runtime starts threads before the worker can read its work).
func ownGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// lower sets the nice value of the group ownGroup made (best effort: a
// render at normal priority is slower for the game, not wrong). Threads
// started later inherit it.
func lower(pid, nice int) { _ = syscall.Setpriority(syscall.PRIO_PGRP, pid, nice) }

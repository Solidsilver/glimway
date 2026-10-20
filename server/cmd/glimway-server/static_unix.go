//go:build unix

package main

import (
	"os"
	"syscall"
)

// fileIdentity tells a file replaced in place (new inode) from the one an
// ETag was cached for, even when its size and timestamp match.
func fileIdentity(info os.FileInfo) uint64 {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return uint64(st.Ino)
	}
	return 0
}

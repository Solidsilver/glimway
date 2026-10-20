//go:build !unix

package main

import "os"

func fileIdentity(os.FileInfo) uint64 { return 0 }

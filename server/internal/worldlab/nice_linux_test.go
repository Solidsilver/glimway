package worldlab

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// niceWorker answers with every thread's nice value, the lab's worker
// as Worker starts it (TestMain: "_nice").
func niceWorker() {
	var out []int
	time.Sleep(50 * time.Millisecond)
	tasks, _ := filepath.Glob("/proc/self/task/*/stat")
	for _, task := range tasks {
		raw, err := os.ReadFile(task)
		if err != nil {
			continue
		}
		// Field 19 (nice), counted after the command's closing parenthesis.
		fields := strings.Fields(string(raw[strings.LastIndexByte(string(raw), ')')+1:]))
		n, _ := strconv.Atoi(fields[16])
		out = append(out, n)
	}
	_ = json.NewEncoder(os.Stdout).Encode(Result{Signatures: func() []uint64 {
		s := make([]uint64, len(out))
		for i, n := range out {
			s[i] = uint64(n)
		}
		return s
	}()})
}

// A lab worker runs niced, all of its threads.
func TestWorkerIsNiced(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	r, err := Worker{Argv: []string{exe, "_nice"}, Nice: 19, Timeout: 10 * time.Second}.Run(context.Background(), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Signatures) < 2 {
		t.Fatal("too few threads read", r.Signatures)
	}
	for _, n := range r.Signatures {
		if n != 19 {
			t.Fatal("a worker thread not niced:", r.Signatures)
		}
	}
}

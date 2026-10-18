package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// DryRun is what migrate --dry-run reports: the copy before and after the
// migrations this binary applies, which ones, and how long they took.
type DryRun struct {
	Before, After BackupSummary
	Applied       []string
	Took          time.Duration
}

// DryRunMigrate rehearses an upgrade on a copy of a database (the release
// rehearsal, docs/releasing.md): verify-backup's checks, the migrations
// themselves, written to the copy, then the checks again. It refuses a file a
// server may have open, so it can't migrate a live database by mistake: a
// running server keeps the -wal and -shm files beside its database, and on
// Linux any process this user can see holding the file counts too.
func DryRunMigrate(ctx context.Context, path string) (DryRun, error) {
	var run DryRun
	abs, err := filepath.Abs(path)
	if err != nil {
		return run, err
	}
	if err = refuseOpenDatabase(abs); err != nil {
		return run, err
	}
	if run.Before, err = VerifyBackup(ctx, abs); err != nil {
		return run, fmt.Errorf("before: %w", err)
	}
	run.Applied = run.Before.PendingNames
	start := time.Now()
	s, err := Open(abs)
	if err != nil {
		return run, fmt.Errorf("migrate: %w", err)
	}
	// Fold the WAL back in, so the immutable read below sees every write.
	if _, err = s.DB.ExecContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)"); err != nil {
		s.Close()
		return run, fmt.Errorf("checkpoint: %w", err)
	}
	if err = s.Close(); err != nil {
		return run, err
	}
	run.Took = time.Since(start)
	if run.After, err = VerifyBackup(ctx, abs); err != nil {
		return run, fmt.Errorf("after: %w", err)
	}
	if run.After.Pending != 0 {
		return run, fmt.Errorf("after: %d migrations still pending", run.After.Pending)
	}
	return run, nil
}

func refuseOpenDatabase(abs string) error {
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Stat(abs + suffix); err == nil {
			return fmt.Errorf("%s exists: a server may have this database open. Rehearse on a copy (glimway-server backup, or a copy of a nightly backup), not the live file", filepath.Base(abs+suffix))
		} else if !os.IsNotExist(err) {
			return err
		}
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return err
	}
	if pids := openedBy(resolved); len(pids) > 0 {
		return fmt.Errorf("process %v has %s open: rehearse on a copy, not a database in use", pids, abs)
	}
	return nil
}

// openedBy lists the processes holding path open, from /proc where there is
// one. Processes of other users are unreadable and so not listed; the -wal
// and -shm check covers a server running as its own user.
func openedBy(path string) []string {
	fds, _ := filepath.Glob("/proc/[0-9]*/fd/*")
	var pids []string
	for _, fd := range fds {
		target, err := os.Readlink(fd)
		if err != nil || (target != path && target != path+"-wal" && target != path+"-shm") {
			continue
		}
		pid := filepath.Base(filepath.Dir(filepath.Dir(fd)))
		if len(pids) == 0 || pids[len(pids)-1] != pid {
			pids = append(pids, pid)
		}
	}
	return pids
}

package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// DryRun is what migrate --dry-run reports: the database before and after
// the migrations this binary applies, which ones, and how long they took.
type DryRun struct {
	Before, After BackupSummary
	Applied       []string
	Took          time.Duration
}

// DryRunMigrate rehearses an upgrade of a database (the release rehearsal,
// docs/releasing.md): verify-backup's checks on it, then the migrations on a
// private snapshot of it in a fresh temporary folder, then the checks again
// on the snapshot. The file it is given is only ever read, read-only and
// immutable, so nothing it points at (a link to a live database, say) can be
// migrated. It also refuses a database that looks in use, since an immutable
// read of one would miss its newest writes: a sidecar (-wal, -shm, -journal)
// beside the real file, a file with more than one name, or, on Linux, any
// process this user can see holding it.
func DryRunMigrate(ctx context.Context, path string) (DryRun, error) {
	var run DryRun
	resolved, err := refuseOpenDatabase(path)
	if err != nil {
		return run, err
	}
	if run.Before, err = VerifyBackup(ctx, resolved); err != nil {
		return run, fmt.Errorf("before: %w", err)
	}
	run.Applied = run.Before.PendingNames
	dir, err := os.MkdirTemp("", "glimway-dry-run-")
	if err != nil {
		return run, err
	}
	defer os.RemoveAll(dir)
	private := filepath.Join(dir, "rehearsal.sqlite")
	if err = snapshot(ctx, resolved, private); err != nil {
		return run, fmt.Errorf("copy: %w", err)
	}
	start := time.Now()
	s, err := Open(private)
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
	if run.After, err = VerifyBackup(ctx, private); err != nil {
		return run, fmt.Errorf("after: %w", err)
	}
	if run.After.Pending != 0 {
		return run, fmt.Errorf("after: %d migrations still pending", run.After.Pending)
	}
	return run, nil
}

// snapshot writes a standalone copy of src to dst, reading src read-only.
func snapshot(ctx context.Context, src, dst string) error {
	dsn := (&url.URL{Scheme: "file", Path: src, RawQuery: "mode=ro&immutable=1"}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	_, err = db.ExecContext(ctx, "VACUUM INTO ?", dst)
	return err
}

// refuseOpenDatabase returns the real path of a database that looks closed.
// Symlinks are resolved first, so sidecars and holders are looked for beside
// and by the file itself, not a link to it.
func refuseOpenDatabase(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("not a database file")
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Nlink > 1 {
		return "", fmt.Errorf("%s has %d hard links: another name may be a database in use. Rehearse on a plain copy (glimway-server backup, or a copy of a nightly backup)", abs, st.Nlink)
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Stat(resolved + suffix); err == nil {
			return "", fmt.Errorf("%s exists: a server may have this database open. Rehearse on a copy (glimway-server backup, or a copy of a nightly backup), not the live file", resolved+suffix)
		} else if !os.IsNotExist(err) {
			return "", err
		}
	}
	if pids := openedBy(info); len(pids) > 0 {
		return "", fmt.Errorf("process %v has %s open: rehearse on a copy, not a database in use", pids, abs)
	}
	return resolved, nil
}

// openedBy lists the processes holding the file open, from /proc where there
// is one, by file identity (device and inode), not name. Processes of other
// users are unreadable and so not listed; the sidecar check covers a server
// running as its own user.
func openedBy(file os.FileInfo) []string {
	fds, _ := filepath.Glob("/proc/[0-9]*/fd/*")
	var pids []string
	for _, fd := range fds {
		held, err := os.Stat(fd)
		if err != nil || !os.SameFile(held, file) {
			continue
		}
		pid := filepath.Base(filepath.Dir(filepath.Dir(fd)))
		if len(pids) == 0 || pids[len(pids)-1] != pid {
			pids = append(pids, pid)
		}
	}
	return pids
}

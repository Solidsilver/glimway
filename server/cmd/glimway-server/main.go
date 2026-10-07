package main

import (
	"context"
	"flag"
	"fmt"
	"glimway/server/internal/api"
	"glimway/server/internal/habitica"
	"glimway/server/internal/store"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// env reads GLIMWAY_<name>, then the deprecated FINGERSNAP_<name> (the
// game's old name, still read so existing deploys keep working).
func env(name, fallback string) string {
	for _, prefix := range []string{"GLIMWAY_", "FINGERSNAP_"} {
		if v := os.Getenv(prefix + name); v != "" {
			return v
		}
	}
	return fallback
}

// lookupEnv is env for settings where an empty value means something.
func lookupEnv(name string) (string, bool) {
	if v, ok := os.LookupEnv("GLIMWAY_" + name); ok {
		return v, true
	}
	return os.LookupEnv("FINGERSNAP_" + name)
}

// defaultDB is .data/glimway.sqlite, or the old .data/fingersnap.sqlite when
// only that one exists, so a local database from before the rename still opens.
func defaultDB() string {
	const path, old = ".data/glimway.sqlite", ".data/fingersnap.sqlite"
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if _, err = os.Stat(old); err == nil {
			return old
		}
	}
	return path
}

func run(args []string) error {
	f := flag.NewFlagSet("glimway-server", flag.ContinueOnError)
	addr := f.String("listen", env("LISTEN", "127.0.0.1:8090"), "HTTP listener")
	path := f.String("db", env("DB", defaultDB()), "SQLite database path")
	base := f.String("habitica-url", env("HABITICA_URL", "https://habitica.com"), "Habitica base URL")
	spriteBase := f.String("habitica-assets-url", env("HABITICA_ASSETS_URL", api.DefaultSpriteBaseURL), "Habitica sprite host (outfit art the bundled cache lacks)")
	spriteDir := f.String("sprite-cache", env("SPRITE_CACHE", ""), "Folder for fetched Habitica sprites (default: habitica-sprites beside the database)")
	tag := f.String("x-client", env("X_CLIENT", "5abfd539-22eb-457f-8e2a-9fb3d66731f1-glimway"), "Habitica creator-id-appname")
	trustedDefault := "127.0.0.1,::1"
	if v, ok := lookupEnv("TRUSTED_PROXIES"); ok {
		trustedDefault = v
	}
	trusted := f.String("trusted-proxies", trustedDefault, "Comma-separated trusted proxy IPs (empty disables forwarded headers)")
	concurrency := f.Int("login-concurrency", 4, "Maximum simultaneous upstream login proofs")
	rate := f.Int("login-rate", 10, "Login attempts per IP or IPv6 /64 per minute")
	globalRate := f.Int("login-global-rate", 60, "Maximum upstream login calls per minute, including retries")
	secureDefault, err := strconv.ParseBool(env("COOKIE_SECURE", "true"))
	if err != nil {
		return fmt.Errorf("invalid GLIMWAY_COOKIE_SECURE")
	}
	secure := f.Bool("cookie-secure", secureDefault, "Secure session cookies (disable only for local HTTP)")
	partyDefault, err := strconv.ParseBool(env("PARTY_ADMISSION", "true"))
	if err != nil {
		return fmt.Errorf("invalid GLIMWAY_PARTY_ADMISSION")
	}
	partyAdmission := f.Bool("party-admission", partyDefault, "Let members of a party with a world here sign in without a code, and make party worlds")
	if err = f.Parse(args); err != nil {
		return err
	}
	proxies := []string{}
	for _, v := range strings.Split(*trusted, ",") {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		if net.ParseIP(v) == nil {
			return fmt.Errorf("invalid trusted proxy IP")
		}
		proxies = append(proxies, v)
	}
	if *concurrency < 1 || *rate < 1 || *globalRate < 1 {
		return fmt.Errorf("invalid login limits")
	}
	if *spriteDir == "" {
		*spriteDir = filepath.Join(filepath.Dir(*path), "habitica-sprites")
	}
	s, err := store.Open(*path)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer s.Close()
	ctx := context.Background()
	cmd := f.Args()
	if len(cmd) > 0 {
		switch cmd[0] {
		case "invite":
			if len(cmd) >= 2 && cmd[1] == "revoke" {
				if len(cmd) != 3 {
					return fmt.Errorf("usage: invite revoke HASH")
				}
				return s.RevokeInvite(ctx, cmd[2])
			}
			if len(cmd) > 2 {
				return fmt.Errorf("usage: invite [world-id]")
			}
			world := ""
			if len(cmd) == 2 {
				world = cmd[1]
			}
			code, err := s.Invite(ctx, world)
			if err != nil {
				return err
			}
			fmt.Println(code)
			return nil
		case "invites":
			if len(cmd) > 2 {
				return fmt.Errorf("usage: invites [player]")
			}
			player := ""
			if len(cmd) == 2 {
				player = cmd[1]
			}
			records, err := s.Invites(ctx, player)
			if err != nil {
				return err
			}
			for _, v := range records {
				fmt.Println(store.JSON(v))
			}
			return nil
		case "parties":
			if len(cmd) != 1 {
				return fmt.Errorf("usage: parties")
			}
			records, err := s.Parties(ctx)
			if err != nil {
				return err
			}
			for _, v := range records {
				fmt.Println(store.JSON(v))
			}
			return nil
		case "party":
			if len(cmd) != 3 {
				return fmt.Errorf("usage: party close|open PARTY-ID | party adopt WORLD-ID")
			}
			switch cmd[1] {
			case "close", "open":
				return s.SetPartyOpen(ctx, cmd[2], cmd[1] == "open")
			case "adopt":
				party, err := s.AdoptWorld(ctx, cmd[2])
				if err != nil {
					return err
				}
				fmt.Printf("world %s is now party %s's world\n", cmd[2], party)
				return nil
			}
			return fmt.Errorf("unknown party command")
		case "flag":
			if len(cmd) != 3 || cmd[1] != "clear" {
				return fmt.Errorf("usage: flag clear ID")
			}
			return s.ClearFlag(ctx, cmd[2])
		case "allowlist":
			if len(cmd) < 2 {
				return fmt.Errorf("usage: allowlist add|remove ID | list")
			}
			switch cmd[1] {
			case "add", "remove":
				if len(cmd) != 3 {
					return fmt.Errorf("usage: allowlist add|remove ID")
				}
				return s.Allow(ctx, cmd[2], cmd[1] == "add")
			case "list":
				if len(cmd) != 2 {
					return fmt.Errorf("usage: allowlist list")
				}
				rows, err := s.DB.Query("SELECT habitica_id,added_by,added_at FROM allowlist ORDER BY habitica_id")
				if err != nil {
					return err
				}
				defer rows.Close()
				for rows.Next() {
					var id, by string
					var at int64
					if err = rows.Scan(&id, &by, &at); err != nil {
						return err
					}
					fmt.Printf("%s\t%s\t%d\n", id, by, at)
				}
				return rows.Err()
			}
			return fmt.Errorf("unknown allowlist command")
		case "notes":
			if len(cmd) != 1 {
				return fmt.Errorf("usage: notes")
			}
			rows, err := s.DB.Query("SELECT habitica_id,reason,ref,reported_xp,created_at FROM ledger WHERE reason IN ('rebirth','xp-loss') ORDER BY id")
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id, reason, ref string
				var xp float64
				var at int64
				if err = rows.Scan(&id, &reason, &ref, &xp, &at); err != nil {
					return err
				}
				fmt.Printf("%s\t%s\t%s\t%.2f\t%d\n", id, reason, ref, xp, at)
			}
			return rows.Err()
		case "flagged":
			if len(cmd) != 1 {
				return fmt.Errorf("usage: flagged")
			}
			rows, err := s.DB.Query("SELECT habitica_id,display_name,flagged_at FROM players WHERE flagged_at IS NOT NULL ORDER BY flagged_at")
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id, name string
				var at int64
				if err = rows.Scan(&id, &name, &at); err != nil {
					return err
				}
				fmt.Printf("%s\t%q\t%d\n", id, name, at)
			}
			return rows.Err()
		case "backup":
			if len(cmd) != 2 {
				return fmt.Errorf("usage: backup destination.sqlite")
			}
			return s.Backup(ctx, cmd[1])
		default:
			return fmt.Errorf("unknown command")
		}
	}
	logger := log.New(os.Stdout, "glimway ", log.LstdFlags|log.LUTC)
	handler := api.New(s, habitica.New(*base, *tag), api.Config{SecureCookie: *secure, Logger: logger, TrustedProxies: proxies, LoginConcurrency: *concurrency, LoginRate: *rate, LoginGlobalRate: *globalRate, SpriteCacheDir: *spriteDir, SpriteBaseURL: *spriteBase, PartyAdmissionOff: !*partyAdmission})
	defer handler.ClosePresence()
	server := &http.Server{Addr: *addr, Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 95 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 << 10}
	stop, done := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer done()
	go handler.RunMailMaintenance(stop)
	go func() {
		<-stop.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		handler.ClosePresence()
		_ = server.Shutdown(shutdown)
	}()
	logger.Printf("listening addr=%s", *addr)
	err = server.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}
func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

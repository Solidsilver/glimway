package main

import (
	"cmp"
	"context"
	"flag"
	"fmt"
	"glimway/server/internal/api"
	"glimway/server/internal/habitica"
	"glimway/server/internal/settings"
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

// The release version and build id, set at link time by the Dockerfile and
// nix/server.nix (-ldflags "-X main.version=… -X main.build=…").
var (
	version = "dev"
	build   = ""
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
	startClock := devClock(f)
	configPath := f.String("config", env("CONFIG", ""), "Settings file (TOML; deploy/glimway.example.toml). Flags and GLIMWAY_* variables win over it")
	adminAddr := f.String("admin-listen", env("ADMIN_LISTEN", ""), "Optional loopback-only profiling/metrics listener, e.g. 127.0.0.1:8091")
	staticDir := f.String("static-dir", env("STATIC_DIR", ""), "Optional built web directory (empty disables static serving)")
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
	flushDefault, err := strconv.Atoi(env("PRESENCE_FLUSH_MS", "0"))
	if err != nil || (flushDefault != 0 && flushDefault != 50 && flushDefault != 100) {
		return fmt.Errorf("invalid GLIMWAY_PRESENCE_FLUSH_MS (want 0, 50, or 100)")
	}
	// Settings with a flag: the flag is the top layer (settings.go, fromFlags).
	defaults := settings.Default().Server.Login
	f.Int("login-concurrency", defaults.Concurrency, "Maximum simultaneous upstream login proofs (server.login.concurrency)")
	f.Int("login-rate", defaults.Rate, "Login attempts per IP or IPv6 /64 per minute (server.login.rate)")
	f.Int("login-global-rate", defaults.GlobalRate, "Maximum upstream login calls per minute, including retries (server.login.global_rate)")
	presenceFlush := f.Int("presence-flush-ms", flushDefault, "Presence output flush interval in ms (0, 50, or 100; default 0)")
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
	if *presenceFlush != 0 && *presenceFlush != 50 && *presenceFlush != 100 {
		return fmt.Errorf("invalid -presence-flush-ms (want 0, 50, or 100)")
	}
	if cmd := f.Args(); len(cmd) > 0 && cmd[0] == "serve-static" {
		if len(cmd) != 1 || *staticDir == "" {
			return fmt.Errorf("usage: -static-dir DIR [-listen ADDR] serve-static")
		}
		return serveStatic(*addr, *staticDir)
	}
	// The settings: defaults, the file, GLIMWAY_* variables, then flags.
	conf, err := settings.Load(*configPath, envLookup, devBuild)
	if err != nil {
		return err
	}
	fromFlags(f, map[string]*int{
		"login-concurrency": &conf.Server.Login.Concurrency,
		"login-rate":        &conf.Server.Login.Rate,
		"login-global-rate": &conf.Server.Login.GlobalRate,
	})
	if err = conf.Check(devBuild); err != nil {
		return err
	}
	live := &liveSettings{path: *configPath}
	live.cur.Store(&conf)
	if cmd := f.Args(); len(cmd) > 0 && cmd[0] == "check-config" {
		if len(cmd) != 1 || *configPath == "" {
			return fmt.Errorf("usage: -config FILE check-config")
		}
		fmt.Printf("ok %s\n", *configPath)
		return nil
	}
	login := conf.Server.Login
	// The settings decide dev mode once there is a file, or GLIMWAY_DEV_ENABLE
	// alone; with neither a dev build serves this machine (local dev, e2e).
	_, devEnv := envLookup("DEV_ENABLE")
	configured := *configPath != "" || devEnv

	clock, err := startClock(configured)
	if err != nil {
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
	if *spriteDir == "" {
		*spriteDir = filepath.Join(filepath.Dir(*path), "habitica-sprites")
	}
	ctx := context.Background()
	cmd := f.Args()
	// Before store.Open: checking a snapshot must not open or migrate -db.
	if len(cmd) > 0 && cmd[0] == "verify-backup" {
		if len(cmd) != 2 {
			return fmt.Errorf("usage: verify-backup backup.sqlite")
		}
		return verifyBackup(ctx, cmd[1])
	}
	// Also before store.Open: the rehearsal migrates its copy, never -db.
	if len(cmd) > 0 && cmd[0] == "migrate" {
		return migrateDryRun(ctx, cmd[1:], *path)
	}
	s, err := store.Open(*path)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer s.Close()
	if len(cmd) > 0 {
		switch cmd[0] {
		case "invite":
			if len(cmd) >= 2 && cmd[1] == "revoke" {
				if len(cmd) != 3 {
					return fmt.Errorf("usage: invite revoke HASH")
				}
				return s.RevokeInvite(ctx, cmd[2], clock.now().Unix())
			}
			if len(cmd) > 2 {
				return fmt.Errorf("usage: invite [world-id]")
			}
			world := ""
			if len(cmd) == 2 {
				world = cmd[1]
			}
			code, err := s.Invite(ctx, world, clock.now().Unix())
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
			if len(cmd) == 2 && cmd[1] != "cli" {
				player, err = s.ResolveOperatorAccount(ctx, cmd[1])
				if err != nil {
					return err
				}
			}
			if len(cmd) == 2 && cmd[1] == "cli" {
				player = "cli"
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
			records, err := s.Parties(ctx, clock.now().Unix())
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
				return s.SetPartyOpen(ctx, cmd[2], cmd[1] == "open", clock.now().Unix())
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
				return fmt.Errorf("usage: flag clear HABITICA-SUBJECT|ACCOUNT-ID")
			}
			account, err := s.ResolveOperatorAccount(ctx, cmd[2])
			if err != nil {
				return err
			}
			return s.ClearFlag(ctx, account, clock.now().Unix())
		case "allowlist":
			if len(cmd) < 2 {
				return fmt.Errorf("usage: allowlist add|remove HABITICA-SUBJECT | list")
			}
			switch cmd[1] {
			case "add", "remove":
				if len(cmd) != 3 {
					return fmt.Errorf("usage: allowlist add|remove ID")
				}
				return s.Allow(ctx, cmd[2], cmd[1] == "add", clock.now().Unix())
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
			rows, err := s.DB.Query("SELECT l.account_id,COALESCE(i.subject,''),l.reason,l.ref,l.reported_xp,l.created_at FROM ledger l LEFT JOIN sign_ins i ON i.account_id=l.account_id AND i.method='habitica' WHERE reason IN ('rebirth','xp-loss') ORDER BY id")
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id, subject, reason, ref string
				var xp float64
				var at int64
				if err = rows.Scan(&id, &subject, &reason, &ref, &xp, &at); err != nil {
					return err
				}
				fmt.Printf("%s\t%s\t%s\t%s\t%.2f\t%d\n", id, subject, reason, ref, xp, at)
			}
			return rows.Err()
		case "flagged":
			if len(cmd) != 1 {
				return fmt.Errorf("usage: flagged")
			}
			rows, err := s.DB.Query("SELECT p.account_id,COALESCE(i.subject,''),p.display_name,p.flagged_at FROM players p LEFT JOIN sign_ins i ON i.account_id=p.account_id AND i.method='habitica' WHERE flagged_at IS NOT NULL ORDER BY flagged_at")
			if err != nil {
				return err
			}
			defer rows.Close()
			for rows.Next() {
				var id, subject, name string
				var at int64
				if err = rows.Scan(&id, &subject, &name, &at); err != nil {
					return err
				}
				fmt.Printf("%s\t%s\t%q\t%d\n", id, subject, name, at)
			}
			return rows.Err()
		case "purse":
			// The owner's purse line (design 2.6): what each top-up did, and
			// the hand settlement of one the checks could not decide.
			if len(cmd) < 2 {
				return fmt.Errorf("usage: purse list [--unconfirmed] | purse settle ID moved|not-moved")
			}
			switch cmd[1] {
			case "list":
				unconfirmed := len(cmd) == 3 && cmd[2] == "--unconfirmed"
				if len(cmd) > 3 || len(cmd) == 3 && !unconfirmed {
					return fmt.Errorf("usage: purse list [--unconfirmed]")
				}
				rows, err := s.PurseTopUpList(ctx, unconfirmed)
				if err != nil {
					return err
				}
				for _, v := range rows {
					fmt.Println(store.JSON(v))
				}
				return nil
			case "settle":
				if len(cmd) != 4 {
					return fmt.Errorf("usage: purse settle ID moved|not-moved")
				}
				return s.SettleTopUpByOwner(ctx, cmd[2], cmd[3], clock.now().Unix())
			}
			return fmt.Errorf("unknown purse command")
		case "backup":
			if len(cmd) != 2 {
				return fmt.Errorf("usage: backup destination.sqlite")
			}
			return s.Backup(ctx, cmd[1])
		default:
			return fmt.Errorf("unknown command")
		}
	}
	// A home past the Commons' gates would have no gate on the lane: refuse to serve rather than lose it.
	if err = api.CheckHomesteadGates(ctx, s.DB); err != nil {
		return err
	}
	logger := log.New(os.Stdout, "glimway ", log.LstdFlags|log.LUTC)
	// The dev build's gate (nil in a release build), set once the API exists.
	var caller devCaller
	handler := api.New(s, habitica.New(*base, *tag), api.Config{Now: clock.now, SecureCookie: *secure, Logger: logger, TrustedProxies: proxies, LoginConcurrency: login.Concurrency, LoginRate: login.Rate, LoginGlobalRate: login.GlobalRate, SpriteCacheDir: *spriteDir, SpriteBaseURL: *spriteBase, PartyAdmissionOff: !*partyAdmission, PresenceFlushMs: *presenceFlush, Version: version, Build: build, WebSettings: func(r *http.Request) any { return webSettings(live, caller, clock.movable)(r) }})
	defer handler.ClosePresence()
	closeAdmin, err := startAdmin(*adminAddr, handler, logger)
	if err != nil {
		return err
	}
	defer closeAdmin()
	caller = devCallerFor(handler, devAccess{configured: configured, settings: live.get})
	httpHandler, closeStatic, err := withStatic(clock.mount(devRoutes(handler, caller)(handler), caller), *staticDir)
	if err != nil {
		return err
	}
	defer closeStatic()
	server := &http.Server{Addr: *addr, Handler: httpHandler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, WriteTimeout: 95 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 16 << 10}
	stop, done := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer done()
	go handler.RunMailMaintenance(stop)
	// SIGHUP (systemctl reload, docker kill -s HUP) reads the settings file again.
	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	defer signal.Stop(hup)
	go func() {
		for {
			select {
			case <-hup:
				live.reload(logger)
			case <-stop.Done():
				return
			}
		}
	}()
	go func() {
		<-stop.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		handler.ClosePresence()
		_ = server.Shutdown(shutdown)
		// Then the detached purse workers (finding 11), bounded by the same
		// shutdown: one about to settle a `moved` row gets its database
		// closed under it otherwise.
		handler.Close(shutdown)
	}()
	logger.Printf("listening addr=%s version=%s build=%s config=%s dev_build=%t dev=%t", *addr, version, cmp.Or(build, "unknown"), cmp.Or(*configPath, "none"), devBuild, conf.Dev.Enable)
	err = server.ListenAndServe()
	if err == http.ErrServerClosed {
		return nil
	}
	return err
}

func verifyBackup(ctx context.Context, path string) error {
	sum, err := store.VerifyBackup(ctx, path)
	if err != nil {
		return fmt.Errorf("verify-backup %s: %w", path, err)
	}
	state := "current"
	if sum.Pending > 0 {
		state = fmt.Sprintf("older; %d migrations apply on restore", sum.Pending)
	}
	fmt.Printf("ok %s\nschema %s (%s)\naccounts %d, worlds %d, homes %d\n", path, sum.Schema, state,
		sum.Counts["players"], sum.Counts["worlds"], sum.Counts["homesteads"])
	return nil
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

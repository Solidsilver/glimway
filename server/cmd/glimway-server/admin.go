package main

import (
	"context"
	"encoding/json"
	"fmt"
	"glimway/server/internal/api"
	"log"
	"net"
	"net/http"
	"net/http/pprof"
	"time"
)

// The admin listener is opt-in and accepts only a loopback bind address.
func startAdmin(addr string, a *api.Server, logger *log.Logger) (func(), error) {
	if addr == "" {
		return func() {}, nil
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("admin listen: %w", err)
	}
	ip := net.ParseIP(host)
	if host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return nil, fmt.Errorf("admin listener must bind to a loopback address")
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	// "localhost" is resolved by the system: check what was actually bound.
	if bound, ok := listener.Addr().(*net.TCPAddr); !ok || !bound.IP.IsLoopback() {
		listener.Close()
		return nil, fmt.Errorf("admin listener must bind to a loopback address")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	mux.HandleFunc("/debug/fights", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(a.FightMeasurements())
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 30 * time.Second}
	go func() {
		if err := server.Serve(listener); err != nil && err != http.ErrServerClosed {
			logger.Printf("admin listener stopped: %v", err)
		}
	}()
	logger.Printf("admin listening addr=%s", listener.Addr())
	return func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = server.Close()
	}, nil
}

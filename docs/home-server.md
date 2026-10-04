# Home server deployment

Host: `ssh home.example.invalid` (`example-host`). Source and production bundle:
`/home/deploy-user/code/fingersnap` and its `dist/` directory.

The NixOS module in `deploy/nixos/fingersnap.nix` is installed at
`/etc/nixos/services/native/fingersnap.nix` and imported by that directory's
`default.nix`. It runs Caddy's static file server as `deploy-user` on
`127.0.0.1:4173`. The main Caddy config at `/etc/nixos/services/caddy.nix`
maps `fsnap.example.invalid` to this listener and handles HTTPS.

## Update the app

From the local repo, copy source without credentials or machine-specific files:

```sh
rsync -az --exclude node_modules --exclude dist --exclude .env \
  --include .env.example --exclude '.env.*' --exclude .playwright-mcp \
  --exclude playwright-report --exclude test-results --exclude .claude \
  --exclude .DS_Store ./ home.example.invalid:code/fingersnap/
```

On the server, use Node from the server's pinned nixpkgs to build:

```sh
nixpkgs_path=$(nix eval --impure --raw --expr \
  '(builtins.getFlake "/etc/nixos").inputs.nixpkgs.outPath')
cd ~/code/fingersnap
nix shell "$nixpkgs_path#nodejs_24" --command bash -c \
  'npm ci --no-audit --no-fund && npm run verify'
```

The file server reads `dist/` directly; rebuilding the app does not require an
OS switch. Change the NixOS module only when service configuration changes.

## Build and activate NixOS

```sh
nh os build /etc/nixos --hostname example-host --no-update-lock-file \
  --out-link ~/fingersnap-nixos-result
nh os switch /etc/nixos --hostname example-host
systemctl status fingersnap --no-pager
curl -I https://fsnap.example.invalid
```

Initial preparation on October 3, 2026 passed `npm run verify` (175 unit tests)
and `nh os build`. Activation was left to the server owner. At preparation
time, `fsnap.example.invalid` did not resolve; add its DNS record pointing to
the home server (like `keeper.example.invalid`) for HTTPS to work.

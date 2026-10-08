# The full e2e suite on a self-hosted runner

GitHub's hosted runners have no GPU, so headless Chromium draws the game's
WebGL with SwiftShader on the CPU. On a four-core Linux runner that made the
full Playwright suite take 10–32 minutes per shard, with timing assertions
failing; GitHub's macOS runners were faster but still uneven (5–17 minutes per
shard). The full suite therefore runs on a self-hosted Linux runner with an
NVIDIA GPU, and the hosted runners keep the quick checks:

| Job | Runner | When |
|---|---|---|
| `verify` (typecheck, unit tests, build, `go test`, Docker smoke test) | GitHub-hosted | every push and pull request |
| `e2e-smoke` (the `@smoke` tier) | GitHub-hosted, software WebGL | every push and pull request |
| `e2e-full` (every playtest) | self-hosted, `[self-hosted, linux, x64, glimway-e2e]` | pushes to `main`, `expansion` and `exp/**` in this repository, and manual dispatch |

This page covers what such a runner needs. Any Linux machine with an NVIDIA
GPU, Docker 25+ and the NVIDIA Container Toolkit will do; the examples use
NixOS.

## Security rules

The repository is public, and a self-hosted runner executes whatever a
workflow tells it to. The rules:

1. **The self-hosted job never runs for pull requests.** Its `if:` allows only
   `push` to this repository's own branches and `workflow_dispatch`, only in
   `Solidsilver/glimway`, and only when the actor is the repository owner.
   The workflow has no `pull_request_target` trigger.
2. **Fork pull requests need approval.** Under Settings → Actions → General,
   set "Approval for running fork pull request workflows" to **Require
   approval for all external contributors**. The `if:` guard lives in the
   workflow file, and a fork's pull request could edit that file, so the
   approval step is what stops a rewritten workflow from reaching the runner.
   Read the diff of `.github/` before approving any run.
3. **The runner has no access to production data or secrets.** Run it as its
   own system user that can't read the application's database, backups or
   the secrets store (for example `/data`, `/var/lib/<app>`, `/run/agenix`).
   The job itself needs no repository secrets. The registration token is read
   by root at service start only, and is hidden from the runner process.
4. **The `docker` group is effectively root.** A user who can talk to the
   Docker socket can start a container that mounts `/` and read or change
   anything on the host. The sandboxing in point 3 therefore keeps the
   *runner process* away from production data. It doesn't stop a malicious
   *job*. This is acceptable only because rules 1 and 2 mean the jobs are the
   owner's own pushes, the same trust any CI runner with Docker access already
   gets. For stricter isolation, use rootless Podman for the runner's
   containers (Podman also takes `--device nvidia.com/gpu=all`): a container
   escape then lands in an unprivileged user, not in root.
5. **Ephemeral registration.** The runner takes one job, deregisters and
   restarts with an empty work directory, so nothing one job leaves behind
   reaches the next. Ephemeral runners need a token that can mint new
   registrations: a fine-grained personal access token (or a GitHub App), not
   a one-hour registration token. See "Token" below.

## How the job runs

`e2e-full` runs inside `mcr.microsoft.com/playwright:v<version>-noble`, the
official image for the `@playwright/test` version in `package-lock.json`
(update the tag with that dependency). Playwright's own Linux Chromium works
there, which it doesn't on hosts like NixOS. The job installs Git, Git LFS and
`sqlite3` with apt, then sets up Node 24 and Go from `go.mod`, runs
`npm ci`, checks the WebGL renderer and runs the suite.

### Container options

```yaml
container:
  image: mcr.microsoft.com/playwright:v1.63.0-noble
  options: >-
    --device nvidia.com/gpu=all      # the GPU, through CDI
    --cgroup-parent=glimway-ci.slice # the host's CI budget (below)
    --memory=6g --memory-swap=10g    # 6 GB RAM, then up to 4 GB of swap
    --cpus=12 --cpu-shares=256       # a CPU cap, and a low weight under contention
    --pids-limit=8192 --shm-size=1g
  volumes:
    - /nix/store:/nix/store:ro       # NixOS hosts only (below)
    - glimway-e2e-cache:/cache       # Go, npm and apt caches between runs
```

- **GPU.** With the NVIDIA Container Toolkit's CDI spec (`nvidia-ctk cdi
  generate`; on NixOS `hardware.nvidia-container-toolkit.enable = true`,
  which also sets Docker's `features.cdi`), Docker 25+ takes `--device
  nvidia.com/gpu=all`. `--gpus all` needs the older `nvidia` runtime
  registered with Docker instead. Use whichever your host has; `docker info`
  lists the runtimes and whether CDI is on.
- **Containers escape the runner service's cgroup.** Docker starts them under
  its own daemon, so a `MemoryMax` on the runner service doesn't cover the
  job. The container's `--memory`/`--cpus` cap the job itself, and
  `--cgroup-parent` puts it in a systemd slice that also holds the runner, so
  one budget covers both.
- **`/nix/store`.** JavaScript actions (`checkout`, `setup-node`, …) run in
  the job container with the runner's own Node, which the runner mounts at
  `/__e`. In the nixpkgs `github-runner` package that Node is a symlink into
  `/nix/store`, so the store is mounted read-only to make it resolve. The NVIDIA
  driver files that NixOS's CDI spec points at live there too. On other hosts
  the mount is unused (Docker creates an empty directory for it). The Nix
  store holds no secrets by design.
- **Caches.** The named volume keeps `GOCACHE`, `GOMODCACHE`, npm's cache and
  apt's downloads between runs. The work directory is wiped after every job,
  so without it each run would download and compile everything again.

### GPU rendering in headless Chromium

`playwright.config.ts` picks the browser's GPU mode from `E2E_GPU`:

| `E2E_GPU` | Platform | Chromium flags |
|---|---|---|
| (unset) | macOS | `--use-angle=metal` |
| `nvidia` | Linux | new headless mode (`channel: 'chromium'`), `--use-angle=vulkan --enable-features=Vulkan --disable-vulkan-surface` |
| `nvidia` with `E2E_GPU_ANGLE=gl-egl` | Linux | new headless mode, `--use-gl=angle --use-angle=gl-egl` |
| `0`, or anything else | any | none: SwiftShader |

Every GPU mode adds `--enable-gpu --ignore-gpu-blocklist
--disable-accelerated-2d-canvas` (2D canvases stay in software because
`e2e/atlases.spec.ts` compares their pixels exactly). The headless shell
Playwright uses by default has no Vulkan, which is why the NVIDIA mode uses
full Chromium in its new headless mode.

Vulkan finds the NVIDIA driver through its ICD manifest. The job looks for
`nvidia_icd.json` (`/run/opengl-driver/share/vulkan/icd.d/` on NixOS,
`/usr/share/vulkan/icd.d/` elsewhere) and exports `VK_DRIVER_FILES` so
Vulkan doesn't fall back to a software driver (lavapipe); it does the same for
the EGL vendor file. Then `node scripts/webgl-renderer.ts` prints the renderer
Chromium gets with the suite's launch options, before the suite starts. A
working setup prints something like `ANGLE (NVIDIA, Vulkan 1.4.x (NVIDIA
GeForce RTX …), NVIDIA)`. If it prints SwiftShader, the run leaves a warning
and the suite still runs, slowly, in software. Set the repository variable
`E2E_GPU_ANGLE=gl-egl` to try EGL instead.

`E2E_LOG_RENDERER=1` also logs the renderer and the first-paint timings from
`e2e/first-paint.spec.ts`.

### Workers and memory

One Playwright worker is a Chromium (browser, GPU and renderer processes) and
its own Go server and fake Habitica. Measured on a Mac (resident memory, which
counts shared pages once per process and so overstates it):

| | Peak |
|---|---|
| 1 worker: Chromium + Go server + Vite + Playwright | 2.9 GB |
| 2 workers, including the multi-page `coop` and `presence` specs | 4.8 GB |
| So: shared base (Vite, the test runner) | ≈ 1.0 GB |
| So: each further worker | ≈ 1.9 GB |

On Linux, counting shared pages once, expect about 1.3–1.5 GB per worker.
Four workers then need about 1.0 + 4 × 1.4 ≈ 6.6 GB at a moment when every
worker peaks together, and usually less, since the peaks don't line up. The
job gets 6 GB of RAM and may spill up to 4 GB into swap (compressed swap such
as zram makes that spill cheap). Set the repository variable `E2E_RUNNER_WORKERS` to change the
count (default 4) without a commit. Raise it once a run's measured peak
(below) leaves room. Each worker keeps about two cores busy, so 12 CPUs cover
four or five workers.

## The runner on NixOS

nixpkgs has `services.github-runners.<name>`. A repository-scoped, ephemeral
runner that starts Docker container jobs:

```nix
{ config, ... }:
let
  user = "github-runner-e2e";
  workDir = "/var/lib/github-runner-work/e2e";
in
{
  users.users.${user} = { isSystemUser = true; group = user; extraGroups = [ "docker" ]; };
  users.groups.${user} = { };
  systemd.tmpfiles.rules = [
    "d /var/lib/github-runner-work 0755 root root - -"
    "d ${workDir} 0750 ${user} ${user} - -"
  ];

  # One budget for the runner and its job containers (--cgroup-parent).
  systemd.slices.glimway-ci.sliceConfig = {
    CPUWeight = 20;
    IOWeight = 20;
    MemoryHigh = "6G";
    MemoryMax = "7G";
    MemorySwapMax = "4G";
  };

  services.github-runners.e2e = {
    enable = true;
    url = "https://github.com/<owner>/<repo>";
    tokenFile = "/run/secrets/github-runner-token"; # a fine-grained PAT
    tokenType = "access";
    extraLabels = [ "glimway-e2e" ];
    ephemeral = true;
    replace = true;
    inherit user workDir;
    group = user;
    extraPackages = [ config.virtualisation.docker.package ];
    serviceOverrides = {
      Slice = "glimway-ci.slice";
      Nice = 10;
      CPUWeight = 20;
      IOWeight = 20;
      MemoryMax = "1G";
      # The module's PrivateUsers=true hides the docker group from the service.
      PrivateUsers = false;
      SupplementaryGroups = [ "docker" ];
      # Keep the runner process away from production data and secrets.
      InaccessiblePaths = [ "-/var/lib/<app>" "-/run/agenix" ];
    };
  };
}
```

Notes:

- **`workDir` on disk.** The module's default work directory is its
  `RuntimeDirectory` under `/run`, a tmpfs: the checkout and `node_modules`
  would sit in RAM.
- **`PrivateUsers = false`.** Without it the runner can't open
  `/run/docker.sock`.
- **Docker and GPU.** `virtualisation.docker.enable` and
  `hardware.nvidia-container-toolkit.enable` (CDI) are needed on the host.

### Token

| Token | Lifetime | Ephemeral runners |
|---|---|---|
| Registration token (`gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token`) | 1 hour | No: the next restart after the hour fails |
| Fine-grained PAT, this repository only, "Administration: read and write" | Up to the expiry you set | Yes: the service mints a registration token from it at each start |
| GitHub App with the same permission (`githubApp` option) | Short-lived tokens minted from a private key | Yes |

Use the fine-grained PAT: it is the simplest token that keeps the runner
ephemeral. Scope it to the one repository. "Administration" is a powerful
permission, so the PAT lives only in the secrets store, where only root can
read it. Set an expiry and a reminder: when it lapses, the runner fails to
re-register after its next job and full-suite runs queue until it's replaced.

## After the first run

- The "Check the WebGL renderer" step shows whether the GPU was used.
- `systemd-cgls -u glimway-ci.slice` during a run shows the runner and the
  job's `docker-<id>.scope` together.
- `/sys/fs/cgroup/glimway-ci.slice/memory.peak` and `memory.swap.peak` give the
  run's peak memory; `memory.events` counts how often it hit `high` or `max`.
  Use them to pick `E2E_RUNNER_WORKERS`.

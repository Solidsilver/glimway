// Agent sandboxes on the dev host block netlink, so os.networkInterfaces()
// throws (errno 97) and Vite cannot start. Preload with
// NODE_OPTIONS=--require=./scripts/netif-shim.cjs (docs/testing.md).
const os = require('os')
const orig = os.networkInterfaces
os.networkInterfaces = function () {
  try { return orig.call(os) } catch { return { lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }] } }
}

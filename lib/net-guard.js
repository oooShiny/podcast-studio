// Guards for server-side fetches of user-supplied URLs. Without these, "add a
// URL source" could be pointed at localhost, the cloud metadata service or
// another machine on the private network (SSRF).
const dns = require("dns");
const net = require("net");

const blocked = new net.BlockList();
// IPv4: unspecified, private, CGNAT, loopback, link-local (incl. metadata), test/reserved, multicast
for (const [addr, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["224.0.0.0", 3],
]) blocked.addSubnet(addr, bits, "ipv4");
// IPv6: unspecified/loopback, unique-local (incl. Fly private fdaa::/16), link-local, multicast
for (const [addr, bits] of [
  ["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
]) blocked.addSubnet(addr, bits, "ipv6");

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (!family) return false;
  if (family === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) must be judged as the IPv4 address it carries.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped) return !blocked.check(mapped[1], "ipv4");
    return !blocked.check(address, "ipv6");
  }
  return !blocked.check(address, "ipv4");
}

// Drop-in `lookup` for http(s).get: resolves the name and refuses if any
// answer is non-public. Because the socket connects to the address checked
// here, a hostname can't pass the check and then re-resolve somewhere else.
function publicOnlyLookup(hostname, options, callback) {
  if (typeof options === "function") { callback = options; options = {}; }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    const list = Array.isArray(address) ? address.map((a) => a.address) : [address];
    if (!list.length || !list.every(isPublicAddress)) {
      return callback(Object.assign(new Error("That address is not reachable from here"), { code: "EBLOCKED" }));
    }
    callback(null, address, family);
  });
}

// For a parsed URL: false when the host is an IP literal in a blocked range
// (literals skip DNS, so the lookup hook never sees them).
function hostAllowed(parsedUrl) {
  const host = parsedUrl.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) return isPublicAddress(host);
  return host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".internal");
}

module.exports = { isPublicAddress, publicOnlyLookup, hostAllowed };

// Synthetic subprocess probe for Socket.connect and these DNS exports only.
// This is not a general network firewall for every Node API.
import net from 'node:net';
import dns from 'node:dns';
const deny = () => { throw new Error('SYNTHETIC_NETWORK_BLOCKED'); };
net.Socket.prototype.connect = deny;
dns.lookup = deny;
dns.lookupService = deny;
for (const name of Object.keys(dns)) {
  if (name.startsWith('resolve') || name === 'reverse') dns[name] = deny;
}

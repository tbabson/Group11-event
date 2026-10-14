import dns from 'dns';
import mongoose from 'mongoose';
import env from './env.js';
import logger from './logger.js';

mongoose.set('strictQuery', true);

// mongodb+srv:// URIs need a DNS SRV lookup, which Node does with its own resolver.
// Some networks/VPNs/local DNS proxies break SRV lookups (querySrv ETIMEOUT) even though
// normal browsing works. DNS_SERVERS=8.8.8.8,1.1.1.1 points Node's resolver elsewhere.
function applyDnsServers() {
  if (!env.DNS_SERVERS.length) return;
  dns.setServers(env.DNS_SERVERS);
  dns.promises.setServers(env.DNS_SERVERS);
  logger.debug({ servers: env.DNS_SERVERS }, 'Using custom DNS servers');
}

async function connectDB(uri) {
  applyDnsServers();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  logger.debug('MongoDB connected');
  return mongoose.connection;
}

async function disconnectDB() {
  await mongoose.disconnect();
}

export { connectDB, disconnectDB };
export default { connectDB, disconnectDB };

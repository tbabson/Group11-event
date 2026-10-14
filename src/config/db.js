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

// Builds every model's indexes before the API takes traffic. Mongoose otherwise builds
// them in the background and swallows failures, so e.g. the events text index could be
// missing and GET /events?q=... would fail with "text index required for $text query".
async function ensureIndexes() {
  for (const model of Object.values(mongoose.models)) {
    try {
      await model.createCollection();
      await model.createIndexes();
    } catch (err) {
      logger.error({ err, model: model.modelName }, 'Index build failed');
      throw err;
    }
  }
}

async function connectDB(uri) {
  applyDnsServers();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  await ensureIndexes();
  logger.debug('MongoDB connected, indexes ready');
  return mongoose.connection;
}

async function disconnectDB() {
  await mongoose.disconnect();
}

export { connectDB, disconnectDB };
export default { connectDB, disconnectDB };

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

// One-off schema changes for databases created by older versions of the app.
async function migrate(connection = mongoose.connection) {
  // A person may now hold several tickets for an event, so the old UNIQUE {event, user}
  // index on registrations must go (it would reject the second ticket of an order).
  const registrations = connection.collection('registrations');
  try {
    const old = (await registrations.indexes()).find((i) => i.name === 'event_1_user_1' && i.unique);
    if (old) {
      await registrations.dropIndex('event_1_user_1');
      await registrations.createIndex({ event: 1, user: 1 });
      logger.info('Migrated: registrations event+user index is no longer unique (multiple tickets per person)');
    }
  } catch (err) {
    if (err?.codeName !== 'NamespaceNotFound') throw err; // brand-new database: nothing to migrate
  }
}

async function connectDB(uri) {
  applyDnsServers();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  await migrate();
  logger.debug('MongoDB connected');
  return mongoose.connection;
}

async function disconnectDB() {
  await mongoose.disconnect();
}

export { connectDB, disconnectDB, migrate };
export default { connectDB, disconnectDB, migrate };

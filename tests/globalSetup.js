import { MongoMemoryReplSet } from 'mongodb-memory-server';

// One single-node replica set for the whole run. Transactions need a replica set.
export default async () => {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  globalThis.__MONGO_REPLSET__ = replSet;
  process.env.MONGO_TEST_URI = replSet.getUri();
};

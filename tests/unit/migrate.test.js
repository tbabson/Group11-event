import mongoose from 'mongoose';
import { migrate } from '../../src/config/db.js';

// Simulates a database created by the old version (unique event+user index on registrations)
// and checks the startup migration lets one person hold several tickets for an event.
describe('startup migration', () => {
  let conn;

  beforeAll(async () => {
    conn = await mongoose
      .createConnection(process.env.MONGO_TEST_URI, { dbName: `migrate_${process.pid}_${Date.now()}` })
      .asPromise();
  });

  afterAll(async () => {
    await conn.dropDatabase();
    await conn.close();
  });

  it('replaces the old unique event+user index with a non-unique one', async () => {
    const coll = conn.collection('registrations');
    await coll.createIndex({ event: 1, user: 1 }, { unique: true });
    const same = { event: new mongoose.Types.ObjectId(), user: new mongoose.Types.ObjectId() };
    await coll.insertOne({ ...same });
    await expect(coll.insertOne({ ...same })).rejects.toMatchObject({ code: 11000 });

    await migrate(conn);

    const idx = (await coll.indexes()).find((i) => i.name === 'event_1_user_1');
    expect(idx).toBeDefined();
    expect(idx.unique).toBeUndefined();
    await expect(coll.insertOne({ ...same })).resolves.toBeDefined();

    await expect(migrate(conn)).resolves.toBeUndefined(); // safe to run on every start
  });

  it('does nothing on a brand-new database', async () => {
    const fresh = await mongoose
      .createConnection(process.env.MONGO_TEST_URI, { dbName: `migrate_new_${process.pid}_${Date.now()}` })
      .asPromise();
    try {
      await expect(migrate(fresh)).resolves.toBeUndefined();
    } finally {
      await fresh.dropDatabase();
      await fresh.close();
    }
  });
});

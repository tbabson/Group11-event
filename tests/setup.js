import mongoose from 'mongoose';
import { jest } from '@jest/globals';
import email from '../src/services/email.service.js';
import '../src/models/User.js';
import '../src/models/RefreshToken.js';
import '../src/models/Event.js';
import '../src/models/TicketType.js';
import '../src/models/Registration.js';
import '../src/models/Payment.js';
import '../src/models/Payout.js';

beforeAll(async () => {
  // Each test file gets its own database on the shared replica set.
  const dbName = `test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  await mongoose.connect(process.env.MONGO_TEST_URI, { dbName });
  // Create collections and indexes up front (unique indexes matter, and
  // transactions can't create collections reliably on first write).
  for (const model of Object.values(mongoose.models)) {
    await model.createCollection();
    await model.init();
  }
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(Object.values(mongoose.models).map((m) => m.deleteMany({})));
  email.queue.length = 0;
  email.testOutbox.length = 0;
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

import mongoose from 'mongoose';

// Runs fn(session) inside a MongoDB transaction (requires a replica set).
// withTransaction retries automatically on transient write conflicts.
async function withTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

export { withTransaction };
export default { withTransaction };

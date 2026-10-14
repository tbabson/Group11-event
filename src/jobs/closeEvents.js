import Event from '../models/Event.js';

// Marks published events that have ended as completed, which also stops registrations.
async function closeEvents(now = new Date()) {
  const { modifiedCount } = await Event.updateMany(
    { status: 'published', endAt: { $lte: now } },
    { status: 'completed' }
  );
  return modifiedCount;
}

export default closeEvents;

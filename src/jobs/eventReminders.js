import Event from '../models/Event.js';
import Registration from '../models/Registration.js';
import notify from '../services/notification.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// Emails confirmed attendees of events starting in the next 24 hours, once each.
async function eventReminders(now = new Date()) {
  const events = await Event.find(
    { status: 'published', startAt: { $gt: now, $lte: new Date(now.getTime() + DAY_MS) } },
    '_id'
  );
  let sent = 0;
  for (const { _id } of events) {
    const regs = await Registration.find({ event: _id, status: 'confirmed', reminderSentAt: null }, '_id');
    for (const reg of regs) {
      // Mark first so an overlapping run can't send the same reminder twice.
      const { modifiedCount } = await Registration.updateOne(
        { _id: reg._id, reminderSentAt: null },
        { reminderSentAt: now }
      );
      if (modifiedCount === 1) {
        await notify.reminder(reg._id);
        sent += 1;
      }
    }
  }
  return sent;
}

export default eventReminders;

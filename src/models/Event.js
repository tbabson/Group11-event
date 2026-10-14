import mongoose from 'mongoose';

const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'completed'];

const eventSchema = new mongoose.Schema(
  {
    organizer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    slug: { type: String, required: true, unique: true },
    description: { type: String, default: '', maxlength: 10000 },
    category: { type: String, required: true, trim: true, lowercase: true },
    venue: {
      name: String,
      address: String,
      city: { type: String, trim: true },
    },
    onlineUrl: String,
    startAt: { type: Date, required: true },
    endAt: { type: Date, required: true },
    capacity: { type: Number, required: true, min: 1 },
    status: { type: String, enum: EVENT_STATUSES, default: 'draft' },
    refundPolicy: { type: String, enum: ['none', 'full'], default: 'none' },
    bannerUrl: String,
  },
  { timestamps: true }
);

eventSchema.index({ startAt: 1 });
eventSchema.index({ category: 1 });
eventSchema.index({ status: 1 });
eventSchema.index({ title: 'text', description: 'text' }, { weights: { title: 5, description: 1 } });

export default mongoose.model('Event', eventSchema);
export { EVENT_STATUSES };

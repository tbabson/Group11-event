import AppError from '../utils/AppError.js';

const isOwnerOrAdmin = (event, user) => user.role === 'admin' || String(event.organizer) === String(user.id);

function assertOwner(event, user) {
  if (!isOwnerOrAdmin(event, user)) throw AppError.forbidden('Only the event organizer can do this', 'NOT_EVENT_OWNER');
}

export { isOwnerOrAdmin, assertOwner };
export default { isOwnerOrAdmin, assertOwner };

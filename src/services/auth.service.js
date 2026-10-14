import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import env from '../config/env.js';
import User from '../models/User.js';
import RefreshToken from '../models/RefreshToken.js';
import AppError from '../utils/AppError.js';
import { randomToken, sha256 } from '../utils/tokens.js';
import notify from './notification.service.js';

const BCRYPT_ROUNDS = env.NODE_ENV === 'test' ? 4 : 12;
const RESET_TTL_MS = 30 * 60 * 1000;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', BCRYPT_ROUNDS);

function signAccessToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    algorithm: 'HS256',
  });
}

async function issueTokens(user) {
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  const refreshToken = jwt.sign({ sub: String(user._id), jti: randomToken(16) }, env.JWT_REFRESH_SECRET, {
    expiresIn: `${env.JWT_REFRESH_TTL_DAYS}d`,
    algorithm: 'HS256',
  });
  await RefreshToken.create({ user: user._id, tokenHash: sha256(refreshToken), expiresAt });
  return { accessToken: signAccessToken(user), refreshToken };
}

async function register({ name, email, password, role }) {
  const existing = await User.exists({ email: email.toLowerCase() });
  if (existing) throw AppError.conflict('EMAIL_TAKEN', 'An account with this email already exists');
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({ name, email, passwordHash, role });
  return { user, ...(await issueTokens(user)) };
}

async function login({ email, password }) {
  const user = await User.findOne({ email: email.toLowerCase() }).select('+passwordHash');
  // Compare even when the user is missing so response time doesn't reveal which emails exist.
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);
  if (!user || !ok) throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
  return { user, ...(await issueTokens(user)) };
}

// Rotates the refresh token. Presenting a token that was already rotated means it
// may have been stolen, so every session for that user is revoked.
async function refresh(token) {
  let payload;
  try {
    payload = jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
  } catch {
    throw AppError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }
  const stored = await RefreshToken.findOneAndUpdate(
    { tokenHash: sha256(token), revokedAt: null },
    { revokedAt: new Date() }
  );
  if (!stored) {
    await RefreshToken.updateMany({ user: payload.sub, revokedAt: null }, { revokedAt: new Date() });
    throw AppError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  }
  const user = await User.findById(stored.user);
  if (!user) throw AppError.unauthorized('Invalid refresh token', 'INVALID_REFRESH_TOKEN');
  return { user, ...(await issueTokens(user)) };
}

async function logout(token) {
  await RefreshToken.updateOne({ tokenHash: sha256(token), revokedAt: null }, { revokedAt: new Date() });
}

async function forgotPassword(email) {
  const user = await User.findOne({ email: email.toLowerCase() });
  if (!user) return; // Same response either way so emails can't be enumerated.
  const token = randomToken(32);
  await User.updateOne(
    { _id: user._id },
    { passwordResetTokenHash: sha256(token), passwordResetExpires: new Date(Date.now() + RESET_TTL_MS) }
  );
  await notify.passwordReset(user, token);
}

async function resetPassword(token, password) {
  const user = await User.findOneAndUpdate(
    { passwordResetTokenHash: sha256(token), passwordResetExpires: { $gt: new Date() } },
    {
      passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS),
      $unset: { passwordResetTokenHash: 1, passwordResetExpires: 1 },
    }
  );
  if (!user) throw AppError.badRequest('INVALID_RESET_TOKEN', 'Reset link is invalid or has expired');
  await RefreshToken.updateMany({ user: user._id, revokedAt: null }, { revokedAt: new Date() });
}

export { register, login, refresh, logout, forgotPassword, resetPassword, signAccessToken, BCRYPT_ROUNDS };
export default { register, login, refresh, logout, forgotPassword, resetPassword, signAccessToken, BCRYPT_ROUNDS };

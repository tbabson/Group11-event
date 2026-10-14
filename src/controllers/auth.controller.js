import auth from '../services/auth.service.js';
import User from '../models/User.js';
import AppError from '../utils/AppError.js';
import { send } from '../utils/http.js';

const session = ({ user, accessToken, refreshToken }) => ({ user, accessToken, refreshToken });

export const register = async (req, res) => send(res, 201, session(await auth.register(req.body)));
export const login = async (req, res) => send(res, 200, session(await auth.login(req.body)));
export const refresh = async (req, res) => send(res, 200, session(await auth.refresh(req.body.refreshToken)));

export const logout = async (req, res) => {
  await auth.logout(req.body.refreshToken);
  send(res, 200, { loggedOut: true });
};

export const forgotPassword = async (req, res) => {
  await auth.forgotPassword(req.body.email);
  send(res, 200, { message: 'If that email is registered, a reset link has been sent' });
};

export const resetPassword = async (req, res) => {
  await auth.resetPassword(req.body.token, req.body.password);
  send(res, 200, { message: 'Password updated. Please log in again.' });
};

export const me = async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw AppError.notFound('User');
  send(res, 200, user);
};

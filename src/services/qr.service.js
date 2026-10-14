import QRCode from 'qrcode';
import { randomToken } from '../utils/tokens.js';

const newQrToken = () => randomToken(32);

const qrPng = (token, width = 300) =>
  QRCode.toBuffer(token, { type: 'png', errorCorrectionLevel: 'M', width, margin: 2 });

export { newQrToken, qrPng };
export default { newQrToken, qrPng };

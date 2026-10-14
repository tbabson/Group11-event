import crypto from 'crypto';

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export { randomToken, sha256 };
export default { randomToken, sha256 };

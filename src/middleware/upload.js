import multer from 'multer';
import AppError from '../utils/AppError.js';

const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];

const bannerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED.includes(file.mimetype)) return cb(null, true);
    return cb(AppError.badRequest('UPLOAD_ERROR', 'Banner must be a JPEG, PNG or WebP image'));
  },
}).single('banner');

export { bannerUpload };
export default { bannerUpload };

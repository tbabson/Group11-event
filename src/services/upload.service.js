import cloudinaryPkg from 'cloudinary';
import env from '../config/env.js';
import AppError from '../utils/AppError.js';

const cloudinary = cloudinaryPkg.v2;

const hasKeys = () => Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);

let configured = false;
// Uses CLOUDINARY_CLOUD_NAME / _API_KEY / _API_SECRET when all three are set; otherwise
// falls back to CLOUDINARY_URL, which the SDK reads from the environment by itself.
function ensureConfigured() {
  if (!hasKeys() && !env.CLOUDINARY_URL) {
    throw new AppError(503, 'UPLOADS_DISABLED', 'Image uploads are not configured on this server');
  }
  if (!configured && hasKeys()) {
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
  }
  configured = true;
}

function uploadBanner(buffer, publicId) {
  ensureConfigured();
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder: env.CLOUDINARY_FOLDER,
          public_id: publicId,
          overwrite: true,
          resource_type: 'image',
          // Store every banner at exactly BANNER_WIDTH × BANNER_HEIGHT (1080 × 608, 16:9): crop to
          // fill around the most important part of the photo, and compress sensibly.
          transformation: [{ width: env.BANNER_WIDTH, height: env.BANNER_HEIGHT, crop: 'fill', gravity: 'auto', quality: 'auto' }],
        },
        (err, result) => (err ? reject(new AppError(502, 'UPLOAD_FAILED', 'Banner upload failed')) : resolve(result.secure_url))
      )
      .end(buffer);
  });
}

// Test hook: forget the applied config so new credentials are picked up.
function _reset() {
  configured = false;
}

export { uploadBanner, _reset };
export default { uploadBanner, _reset };

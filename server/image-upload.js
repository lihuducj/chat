const sharp = require('sharp');
const path = require('node:path');
const fs = require('node:fs/promises');
const { nanoid } = require('nanoid');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
let activeDecoders = 0;
sharp.concurrency(1);
sharp.cache({ memory: 32, files: 0, items: 16 });

function uploadError(message, status = 400) {
  return Object.assign(new Error(message), { uploadStatus: status });
}

async function cleanImage(input, privateDirectory) {
  if (activeDecoders >= 2) throw uploadError('图片处理中，请稍后再试', 503);
  activeDecoders++;
  let output;
  try {
    // Decode and re-encode; never publish the caller's raw bytes, EXIF, or suffix.
    const image = sharp(input, { animated: true, failOn: 'warning', limitInputPixels: 40000000 });
    const metadata = await image.metadata();
    const pages = metadata.pages || 1;
    const frameHeight = metadata.pageHeight || metadata.height;
    if (!FORMATS.has(metadata.format) || !metadata.width || !frameHeight || pages > 100 ||
        metadata.width > 12000 || frameHeight > 12000 || metadata.width * frameHeight * pages > 40000000) {
      throw uploadError('图片格式不支持或尺寸过大，请使用 JPG、PNG、WebP、GIF 图片');
    }
    const extension = metadata.format === 'jpeg' ? 'jpg' : metadata.format;
    const filename = nanoid() + '.' + extension;
    output = path.join(privateDirectory, 'clean-' + filename);
    const pipeline = metadata.format === 'jpeg' ? image.rotate() : image;
    await pipeline.toFormat(metadata.format, metadata.format === 'jpeg' ? { quality: 95 } : {})
      .timeout({ seconds: 15 }).toFile(output);
    const info = await fs.stat(output);
    if (!info.size || info.size > MAX_IMAGE_BYTES) throw uploadError('处理后的图片不能超过 20MB');
    return { path: output, filename, size: info.size, extension };
  } catch (error) {
    if (output) await fs.unlink(output).catch(() => {});
    if (error.uploadStatus) throw error;
    throw uploadError('无法识别有效图片，请重新选择 JPG、PNG、WebP、GIF 图片');
  } finally {
    activeDecoders--;
  }
}

module.exports = { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, cleanImage };

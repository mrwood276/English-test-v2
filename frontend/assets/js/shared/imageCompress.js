/**
 * Shrinks a photo in the browser before it is uploaded, so phones and the school connection are not loaded with
 * 5 MB pictures. Result: the same picture, at most `maxSide` pixels on the long side, and at most `maxBytes`.
 */
const READABLE = ["image/jpeg", "image/png", "image/webp"];
const QUALITIES = [0.85, 0.72, 0.58, 0.45];

function toBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function decode(file) {
  try {
    return await createImageBitmap(file);
  } catch {
    // Older browsers: fall back to an <img> element.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

const withExtension = (name, ext) => `${String(name).replace(/\.[^.]*$/, "") || "image"}.${ext}`;

export async function prepareImage(file, { maxBytes = 1_000_000, maxSide = 1600 } = {}) {
  if (!READABLE.includes(file.type)) throw new Error("Use a JPG, PNG, or WebP picture.");
  let source;
  try {
    source = await decode(file);
  } catch {
    throw new Error("This picture could not be read. Try another file.");
  }
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;

  // Already small enough in bytes and pixels: keep the original untouched.
  if (file.size <= maxBytes && Math.max(width, height) <= maxSide) {
    if (source.close) source.close();
    return { blob: file, mime: file.type, name: file.name };
  }

  let scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  while (Math.max(width, height) * scale >= 400) {
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    ctx.fillStyle = "#ffffff"; // pictures with transparency get a white background if WebP is not available
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    for (const quality of QUALITIES) {
      let blob = await toBlob(canvas, "image/webp", quality);
      if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", quality); // browsers without WebP encoding
      if (blob && blob.size <= maxBytes) {
        if (source.close) source.close();
        const ext = blob.type === "image/webp" ? "webp" : "jpg";
        return { blob, mime: blob.type, name: withExtension(file.name, ext) };
      }
    }
    scale *= 0.75;
  }
  if (source.close) source.close();
  throw new Error("This picture is too detailed to shrink to about 1 MB. Try a simpler picture.");
}

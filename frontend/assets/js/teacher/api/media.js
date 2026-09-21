import { callStaffFunction } from "../../core/api.js";
import { SUPABASE_PUBLISHABLE_KEY } from "../../core/config.js";
import { NetworkError, HttpError } from "../../core/http.js";

const call = (body) => callStaffFunction("media", { method: "POST", body });

export const media = {
  createUpload: ({ mime_type, size_bytes }) => call({ action: "create_upload", mime_type, size_bytes }),
  register: ({ path, name, duration_seconds }) => call({ action: "register", path, name, duration_seconds }).then((r) => r.media),
  signedUrls: (ids) => (ids.length ? call({ action: "signed_urls", ids }).then((r) => r.urls) : Promise.resolve({})),
};

/** Adds a short-lived viewing link (`url`) to every file of a question and of its reading text. Best effort. */
export async function attachMediaUrls(question) {
  const files = [...(question.media || []), ...((question.passage && question.passage.media) || [])];
  if (files.length === 0) return question;
  try {
    const urls = await media.signedUrls([...new Set(files.map((f) => f.id))]);
    for (const f of files) f.url = urls[f.id] || null;
  } catch {
    /* without links the files are still listed, just without a player */
  }
  return question;
}

/**
 * Sends the file to Storage through the one-time upload link (same request the Supabase client makes:
 * PUT, multipart with a "cacheControl" field and the file in a field with an empty name).
 * XMLHttpRequest is used because fetch cannot report upload progress.
 */
export function uploadToSignedUrl(url, blob, name, { onProgress, timeoutMs = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("cacheControl", "3600");
    form.append("", blob, name);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("apikey", SUPABASE_PUBLISHABLE_KEY);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.timeout = timeoutMs;
    if (onProgress) xhr.upload.addEventListener("progress", (e) => e.lengthComputable && onProgress(e.loaded / e.total));
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = "The file could not be uploaded. Please try again.";
      try { const body = JSON.parse(xhr.responseText); if (xhr.status === 413) message = "The file is too large."; else if (body && body.message && xhr.status < 500) message = `The file could not be uploaded (${body.message}).`; } catch { /* keep the default */ }
      reject(new HttpError(xhr.status, message));
    });
    xhr.addEventListener("error", () => reject(new NetworkError("Could not reach the server. Check your internet connection and try again.")));
    xhr.addEventListener("timeout", () => reject(new NetworkError("The upload took too long. Check your connection and try again.")));
    xhr.send(form);
  });
}

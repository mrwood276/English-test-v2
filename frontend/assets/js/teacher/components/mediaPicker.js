import { h } from "../../shared/dom.js";
import { icon } from "../../shared/icons.js";
import { prepareImage } from "../../shared/imageCompress.js";
import { media, uploadToSignedUrl } from "../api/media.js";
import { SessionExpiredError } from "../../core/auth.js";

const AUDIO_MAX = 10 * 1024 * 1024;
const AUDIO_TYPES = { mp3: "audio/mpeg", m4a: "audio/mp4" };
const ACCEPT = "image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/x-m4a,.mp3,.m4a";

const sizeText = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const durationText = (s) => (Number.isFinite(s) && s !== null ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "");
const extension = (name) => (String(name).split(".").pop() || "").toLowerCase();

function audioMime(file) {
  if (Object.values(AUDIO_TYPES).includes(file.type)) return file.type;
  if (file.type === "audio/x-m4a" || file.type === "audio/m4a") return "audio/mp4";
  return AUDIO_TYPES[extension(file.name)] || null;
}

function readDuration(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
    const timer = setTimeout(() => done(null), 4000);
    audio.preload = "metadata";
    audio.addEventListener("loadedmetadata", () => { clearTimeout(timer); done(Number.isFinite(audio.duration) ? Math.round(audio.duration) : null); });
    audio.addEventListener("error", () => { clearTimeout(timer); done(null); });
    audio.src = url;
  });
}

/**
 * Attach images and audio to a question or reading text.
 *  items:    [{ id, kind, name, size_bytes, duration_seconds, url? }] already attached
 *  onChange: called with the new list after every successful upload or removal
 * Files are uploaded one at a time; images are shrunk to about 1 MB first.
 */
export function mediaPicker({ items = [], max = 4, id, describedBy, onChange }) {
  let list = items.map((m) => ({ ...m }));
  const queue = [];
  let working = false;
  let pending = 0; // files being prepared or uploaded

  const listEl = h("ul", { class: "media-list", "aria-label": "Attached files" });
  const messages = h("div", { class: "media-messages", role: "status", "aria-live": "polite" });
  const input = h("input", { type: "file", id, accept: ACCEPT, multiple: true, class: "visually-hidden", "aria-describedby": describedBy });
  const choose = h("label", { class: "btn small ghost", for: id }, icon("plus"), "Add images or audio");
  const zone = h("div", { class: "drop", "data-dropzone": "" }, icon("image"), h("span", {}, "Drop files here, or "), choose, h("span", { class: "hint" }, "JPG, PNG, WebP (shrunk to about 1 MB), MP3 or M4A (up to 10 MB). At most " + max + " files."));
  const el = h("div", { class: "media-picker" }, listEl, zone, input, messages);

  const notify = () => onChange && onChange(list.map((m) => ({ ...m })));
  const say = (text, kind = "error") => { messages.append(h("div", { class: `media-msg ${kind}` }, text)); };

  function render() {
    listEl.replaceChildren(
      ...list.map((m) => {
        const remove = h("button", { class: "icon-btn", type: "button", "aria-label": `Remove ${m.name || "file"}` }, icon("plus"));
        remove.addEventListener("click", () => { list = list.filter((x) => x.id !== m.id); render(); notify(); });
        const preview = m.kind === "image"
          ? (m.url ? h("img", { class: "thumb", src: m.url, alt: "" }) : h("span", { class: "thumb ph" }, icon("image")))
          : (m.url ? h("audio", { class: "player", controls: true, preload: "none", src: m.url }) : h("span", { class: "thumb ph" }, icon("audio")));
        const meta = [m.kind === "image" ? "Image" : "Audio", sizeText(m.size_bytes), durationText(m.duration_seconds)].filter(Boolean).join(", ");
        return h("li", { class: "media-item", "data-media-id": m.id }, preview, h("div", { class: "media-info" }, h("strong", {}, m.name || "File"), h("span", { class: "hint" }, meta)), remove);
      }),
      ...queue.map((q) => h("li", { class: "media-item uploading" }, h("span", { class: "thumb ph" }, icon(q.kind === "audio" ? "audio" : "image")), h("div", { class: "media-info" }, h("strong", {}, q.name), h("span", { class: "hint" }, q.stage)))),
    );
    zone.classList.toggle("full", list.length + pending >= max);
  }

  async function processOne(job) {
    const { file } = job;
    try {
      let blob = file, mime, name = file.name, duration = null;
      if (file.type.startsWith("image/")) {
        job.kind = "image"; job.stage = "Shrinking…"; render();
        ({ blob, mime, name } = await prepareImage(file));
      } else {
        job.kind = "audio";
        mime = audioMime(file);
        if (!mime) throw new Error("This file type is not supported. Use JPG, PNG, WebP, MP3, or M4A.");
        if (file.size > AUDIO_MAX) throw new Error(`This audio is ${sizeText(file.size)}. The limit is 10 MB.`);
        duration = await readDuration(file);
      }
      job.stage = "Uploading…"; job.progress = 0; render();
      const upload = await media.createUpload({ mime_type: mime, size_bytes: blob.size });
      await uploadToSignedUrl(upload.upload_url, blob, name, { onProgress: (p) => { job.stage = `Uploading… ${Math.round(p * 100)}%`; render(); } });
      job.stage = "Saving…"; render();
      const saved = await media.register({ path: upload.path, name, duration_seconds: duration });
      try {
        const urls = await media.signedUrls([saved.id]);
        saved.url = urls[saved.id] || null;
      } catch { /* the file is attached; it just has no preview yet */ }
      list.push(saved);
      notify();
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      say(`${file.name}: ${err.message || "The file could not be added."}`);
    }
  }

  async function work() {
    if (working) return;
    working = true;
    while (queue.length) {
      const job = queue[0];
      await processOne(job);
      queue.shift();
      pending--;
      render();
    }
    working = false;
  }

  function add(files) {
    messages.replaceChildren();
    for (const file of files) {
      const isImage = /^image\/(jpeg|png|webp)$/.test(file.type);
      const isAudio = Boolean(audioMime(file));
      if (!isImage && !isAudio) { say(`${file.name}: This file type is not supported. Use JPG, PNG, WebP, MP3, or M4A.`); continue; }
      if (list.length + pending >= max) { say(`${file.name}: You can attach at most ${max} files. Remove one first.`); continue; }
      pending++;
      queue.push({ file, name: file.name, kind: isImage ? "image" : "audio", stage: "Waiting…" });
    }
    render();
    work();
  }

  input.addEventListener("change", () => { add([...input.files]); input.value = ""; });
  for (const type of ["dragenter", "dragover"]) zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add("over"); });
  for (const type of ["dragleave", "drop"]) zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove("over"); });
  zone.addEventListener("drop", (e) => add([...(e.dataTransfer ? e.dataTransfer.files : [])]));

  render();
  return {
    el,
    get items() { return list.map((m) => ({ ...m })); },
    get busy() { return pending > 0; },
    set(next) { list = next.map((m) => ({ ...m })); render(); },
  };
}

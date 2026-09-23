// Small line icons (24x24, drawn with the current text color). The markup below is fixed text written here,
// never data from the server.
const PATHS = {
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="16" r="2"/>',
  image: '<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4.5 17l5-4.5 3.5 3 2.5-2 4 3.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  book: '<path d="M5 4h10a3 3 0 013 3v13H8a3 3 0 01-3-3z"/><path d="M5 17a3 3 0 013-3h10"/>',
  dash: '<rect x="4" y="4" width="7" height="9" rx="1.5"/><rect x="13" y="4" width="7" height="5" rx="1.5"/><rect x="13" y="11" width="7" height="9" rx="1.5"/><rect x="4" y="15" width="7" height="5" rx="1.5"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
  chart: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.1"/>',
  sheet: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15h16M10 4v16"/>',
  pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  flag: '<path d="M6 4h12v17l-6-4-6 4z"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  cloud: '<path d="M7 18a4 4 0 010-8 5 5 0 019.5-1A3.6 3.6 0 0117 18z"/><path d="M9.5 13.5l2 2 3.5-4"/>',
  play: '<path d="M8.5 5.5l10 6.5-10 6.5z"/>',
  offline: '<path d="M3 3l18 18"/><path d="M5 12.5a10 10 0 0114 0"/><path d="M8.5 16a5 5 0 018.5 0"/><circle cx="12" cy="19.6" r=".6"/>',
};

export function icon(name, label) {
  const span = document.createElement("span");
  span.className = "icon";
  span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] || ""}</svg>`;
  if (label) {
    span.setAttribute("role", "img");
    span.setAttribute("aria-label", label);
    span.title = label;
  }
  return span;
}

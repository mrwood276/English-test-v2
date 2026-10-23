/**
 * Offline-capable student shell (TASK-042 / INS-20).
 * Caches student static assets so a phone that disconnects or reloads offline can still
 * mount the student app and display the ongoing exam from localStorage.
 *
 * Cache name is versioned; a newer service worker removes older caches on activate.
 * All *.supabase.co API/storage requests bypass the cache completely.
 */

const CACHE_NAME = "eng-test-student-v2.1";

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./assets/css/tokens.css",
  "./assets/css/base.css",
  "./assets/css/student.css",
  "./assets/js/core/config.js",
  "./assets/js/core/api.js",
  "./assets/js/core/http.js",
  "./assets/js/student/app.js",
  "./assets/js/student/api.js",
  "./assets/js/student/store.js",
  "./assets/js/student/limits.js",
  "./assets/js/student/screens/join.js",
  "./assets/js/student/screens/exam.js",
  "./assets/js/student/screens/result.js",
  "./assets/js/student/components/question.js",
  "./assets/js/shared/dom.js",
  "./assets/js/shared/icons.js",
  "./assets/js/shared/rich.js",
  "./assets/js/shared/error.js",
  "./assets/js/shared/ui.js",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) =>
          caches.delete(key)
        ),
      )
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never cache backend Edge Functions, auth, or storage calls
  if (
    url.origin.includes("supabase.co") || url.pathname.includes("/functions/")
  ) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        fetch(req).then((networkRes) => {
          if (
            networkRes && networkRes.status === 200 &&
            networkRes.type === "basic"
          ) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((networkRes) => {
        if (
          !networkRes || networkRes.status !== 200 ||
          networkRes.type !== "basic"
        ) {
          return networkRes;
        }
        const clone = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        return networkRes;
      }).catch(() => {
        if (req.mode === "navigate") {
          return caches.match("./index.html");
        }
      });
    }),
  );
});

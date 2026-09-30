// Service worker:
// 1. Offline: the site's own files (page, script, styles, sets.json, icons) are fetched from
//    the network first and a copy is kept, used only when there's no connection.
//    Audio isn't handled here: saved sets are stored separately by the page ("Save offline").
// 2. Notifications: pushes carry no data, so we read sets.json and announce the newest set.

const SHELL_CACHE = "mds-shell-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (req.method !== "GET" || url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") return (await caches.match(scope.href)) || Response.error();
        return Response.error();
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let title = "New set on MDS";
      let body = "A new set is up. Tap to listen.";
      let url = self.registration.scope;
      try {
        const res = await fetch(new URL("sets.json", self.registration.scope), { cache: "no-store" });
        const newest = (await res.json()).sets?.[0];
        if (newest) {
          body = [newest.title, newest.authors?.join(" & ")].filter(Boolean).join(" · ");
          url = `${self.registration.scope}#${newest.id}`;
        }
      } catch {}
      await self.registration.showNotification(title, {
        body,
        icon: new URL("icon-192.png", self.registration.scope).href,
        badge: new URL("icon-192.png", self.registration.scope).href,
        data: { url },
        tag: "new-set",
        silent: true, // show it, but no sound or vibration
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => w.url.startsWith(self.registration.scope));
      if (open) {
        await open.navigate(url).catch(() => {});
        return open.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});

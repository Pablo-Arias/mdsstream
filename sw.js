// Service worker: shows a notification when the Worker signals a new set.
// Pushes carry no data, so we read sets.json and announce the newest set.
// No fetch handler on purpose: the site is never served from a stale cache.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

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

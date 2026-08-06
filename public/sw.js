// Medicine Ledger — service worker
// Handles push events even when the app/tab isn't open, and turns them
// into real notifications in the phone's notification bar.

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {
    data = { title: 'Medicine Ledger', body: event.data ? event.data.text() : 'You have a new alert.' };
  }

  var title = data.title || 'Medicine Ledger';
  var options = {
    body: data.body || '',
    tag: data.tag || 'medledger',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    renotify: true,
    data: { url: '/' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url.indexOf(self.location.origin) === 0 && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});

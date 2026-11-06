/* global self, fetch */
// P&N — service worker tối thiểu để Chrome cho cài dashboard thành ứng dụng.
// Không cache gì: dữ liệu công ty phải luôn là bản mới nhất, và mỗi lần deploy
// không được để lại giao diện cũ trong máy người dùng.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') event.respondWith(fetch(event.request));
});

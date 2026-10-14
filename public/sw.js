// Service worker minimal : requis pour l'installation en application. Aucune mise en cache (données toujours à jour).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

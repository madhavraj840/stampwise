// Push only: no offline caching. A push says "a stamp request arrived"; open dashboards sync, otherwise show a notification.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('push',e=>e.waitUntil((async()=>{
  const wins=await self.clients.matchAll({type:'window',includeUncontrolled:true});
  wins.forEach(w=>w.postMessage({t:'sync'}));
  if(!wins.some(w=>w.visibilityState==='visible'))await self.registration.showNotification('New stamp request',{body:'A customer is waiting for a stamp.',tag:'stamp-req',renotify:true});
})()));
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil((async()=>{
  const w=(await self.clients.matchAll({type:'window',includeUncontrolled:true})).find(c=>new URL(c.url).pathname==='/shop');
  return w?w.focus():self.clients.openWindow('/shop');
})())});

/* ISOLATED world. The page bridge is untrusted, even when event.source is window. */
(() => {
  'use strict';
  const C=globalThis.DhuBankCore;
  let queue=[], draining=false;
  async function drain() {
    if (draining) return;
    draining=true;
    while (queue.length) {
      const message=queue.shift();
      try { await chrome.runtime.sendMessage({kind:'collect',pageHref:location.href,payload:message}); }
      catch { /* Extension reload/context invalidation must not affect the site. */ }
    }
    draining=false;
  }
  window.addEventListener('message',event => {
    if (event.source !== window || event.origin !== 'https://aidhu.net' || queue.length >= 200) return;
    try {
      const safe = C.bridgeMessage(event.data,location.href);
      queue.push(safe);
      void drain();
    } catch { /* Unknown messages, wrong route, extra credential fields and malformed data ignored. */ }
  });
})();

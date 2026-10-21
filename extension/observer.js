/* MAIN world. Observe only the three normal practice responses; no new requests. */
(() => {
  'use strict';
  const C = globalThis.DhuBankCore;
  if (!C || globalThis.__dhuObserverInstalled) return;
  globalThis.__dhuObserverInstalled = true;
  const MAX_BYTES = 5 * 1024 * 1024;
  const post = window.postMessage.bind(window);
  const current = () => C.isPracticePage(location.href);
  function metadata(input, init) {
    try {
      // Do not access init.headers, Request.headers, body, credentials or cookies.
      const method = init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET');
      // Vue can start the async load before committing the browser hash.
      // Match only the exact endpoints here; require practice mode on response.
      if (String(method).toUpperCase() !== 'GET') return null;
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input instanceof Request ? input.url : '';
      return C.endpoint(url,location.href);
    } catch { return null; }
  }
  function emit(meta, body) {
    try {
      if (!current() || !body || body.code !== 200 || !Array.isArray(body.data) || body.data.length > 10000) return;
      let batch=[], size=0;
      const flush = () => {
        if (batch.length) post({marker:C.MARKER,version:1,meta,questions:batch},'https://aidhu.net');
        batch=[]; size=0;
      };
      for (const row of body.data) {
        try {
          const safe = C.filterRow(row,meta), length = JSON.stringify(safe).length;
          // Skip malformed rows individually; never include unknown properties.
          if (length > C.MAX_MESSAGE/2) continue;
          if (batch.length >= C.MAX_ROWS || size+length > C.MAX_MESSAGE/2) flush();
          batch.push(safe); size+=length;
        } catch { /* Bad row must not break the site's normal request. */ }
      }
      flush();
    } catch { /* Response observation never affects the page. */ }
  }
  async function readJSON(response) {
    const clone = response.clone(), reader = clone.body?.getReader();
    if (!reader) return null;
    let bytes=0, chunks=[];
    try {
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BYTES) { void reader.cancel().catch(() => {}); return null; }
        chunks.push(value);
      }
      const all = new Uint8Array(bytes); let offset=0;
      for (const chunk of chunks) { all.set(chunk,offset); offset+=chunk.byteLength; }
      return JSON.parse(new TextDecoder().decode(all));
    } finally { reader.releaseLock(); }
  }
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') window.fetch = function(input,init) {
    const meta = metadata(input,init);
    const promise = Reflect.apply(originalFetch,this,arguments);
    if (meta) void promise.then(async response => {
      if (!response.ok || !current()) return;
      const finalMeta = C.endpoint(response.url,location.href);
      if (!finalMeta || C.stable(finalMeta) !== C.stable(meta)) return;
      emit(meta,await readJSON(response));
    }).catch(() => {});
    return promise;
  };
  if (typeof XMLHttpRequest !== 'undefined') {
    const states=new WeakMap(), open=XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method,url) {
      const meta = metadata(typeof url === 'string' || url instanceof URL ? String(url) : '',{method});
      const result = Reflect.apply(open,this,arguments);
      if (!states.has(this)) {
        this.addEventListener('load',() => {
          try {
            const active = states.get(this);
            if (!active || this.status < 200 || this.status >= 300 || !current()) return;
            const finalMeta = C.endpoint(this.responseURL,location.href);
            if (!finalMeta || C.stable(finalMeta) !== C.stable(active)) return;
            if (this.responseType === 'json') {
              if (JSON.stringify(this.response).length <= MAX_BYTES) emit(active,this.response);
            } else if (!this.responseType || this.responseType === 'text') {
              if (this.responseText.length <= MAX_BYTES) emit(active,JSON.parse(this.responseText));
            }
          } catch { /* Unsupported responseType, parse errors, and site failures are ignored. */ }
        });
      }
      states.set(this,meta);
      return result;
    };
  }
})();

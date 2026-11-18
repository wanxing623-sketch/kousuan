/* Inlined in both the page and its service worker. A transaction commits the blob
 * and its metadata together. Checking a large pack only reads a header and a key,
 * not 33 MB of model data on every visit. The database is local to this Pages app. */
function createVoiceStore(base) {
  let opened;
  function database() {
    if (!opened) opened = new Promise((resolve, reject) => {
      const request = indexedDB.open('kousuan-offline:' + encodeURIComponent(new URL(base).pathname), 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('headers');
        request.result.createObjectStore('bodies');
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opened = null; };
        resolve(db);
      };
    }).catch(error => { opened = null; throw error; });
    return opened;
  }
  async function transact(mode, work) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['headers', 'bodies'], mode);
      let result;
      tx.oncomplete = () => {
        try { resolve(result && result()); } catch (error) { reject(error); }
      };
      tx.onabort = () => reject(tx.error || new Error('本机存储事务中断'));
      try { result = work(tx.objectStore('headers'), tx.objectStore('bodies')); }
      catch (error) { tx.abort(); reject(error); }
    });
  }
  const key = url => new URL(url, base).href;
  function put(url, blob, headers, digest) {
    const id = key(url);
    return transact('readwrite', (meta, bodies) => {
      meta.put({ headers: Array.from(new Headers(headers)), digest, size: blob.size }, id);
      bodies.put(blob, id);
    });
  }
  function has(url, digest) {
    const id = key(url);
    return transact('readonly', (meta, bodies) => {
      const header = meta.get(id), count = bodies.count(id);
      return () => Boolean(count.result && header.result && (!digest || header.result.digest === digest));
    });
  }
  function match(url) {
    const id = key(url);
    return transact('readonly', (meta, bodies) => {
      const header = meta.get(id), body = bodies.get(id);
      return () => header.result && body.result && body.result.size === header.result.size
        ? new Response(body.result, { headers: header.result.headers }) : null;
    });
  }
  // Fetch bodies are already decoded. Keep CSP and other document policies, not
  // compression metadata that no longer describes the saved blob.
  async function putResponse(url, response) {
    const headers = new Headers(response.headers);
    ['Content-Encoding', 'Content-Length', 'Cache-Control'].forEach(name => headers.delete(name));
    await put(url, await response.blob(), headers);
  }
  return { has, match, put, putResponse };
}

// Thin HTTP client for the Checklisten API.
// Auth is cookie-based, so every fetch carries credentials.
window.API = (() => {
  const base = (() => {
    // When the frontend is served by the backend itself (same origin), use relative URLs.
    // When opened separately (e.g. file:// or another origin), allow override.
    if (window.__API_BASE__) return window.__API_BASE__;
    return '';
  })();

  async function req(method, path, body, opts = {}) {
    const init = {
      method,
      credentials: 'include',
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
    };
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    if (res.status === 204) return null;
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!res.ok) {
      const err = new Error((parsed && parsed.error) || `${method} ${path} → ${res.status}`);
      err.status = res.status;
      err.body = parsed;
      throw err;
    }
    return parsed;
  }

  return {
    base,
    get:   (p)     => req('GET',    p),
    post:  (p, b)  => req('POST',   p, b),
    put:   (p, b)  => req('PUT',    p, b),
    patch: (p, b)  => req('PATCH',  p, b),
    del:   (p)     => req('DELETE', p),
    upload: (p, formData) => req('POST', p, formData),

    // Convenience
    auth: {
      me:     () => req('GET',  '/api/auth/me'),
      login:  (username, password) => req('POST', '/api/auth/login', { username, password }),
      logout: () => req('POST', '/api/auth/logout'),
    },
  };
})();

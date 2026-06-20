// htmx + Alpine wiring for the admin panel.
//
// Real htmx (loaded in admin-head.hbs) drives the request/swap lifecycle straight
// from the hx-* attributes in the templates, so this file only covers the
// cross-cutting behaviours htmx leaves to the application:
//   1. bounce to the login page when the admin session has expired (401)
//   2. surface a generic failure when a request errors out
//   3. bring Alpine components inside server-swapped fragments to life

// A 401 means the admin cookie expired mid-session. htmx never swaps a non-2xx
// response, so intercept before the (no-op) swap and redirect to login.
document.body.addEventListener('htmx:beforeSwap', (event) => {
  if (event.detail.xhr.status === 401) {
    event.detail.shouldSwap = false;
    window.location.assign('/admin/login?expired=1');
  }
});

// Any other non-2xx (htmx:responseError) or transport failure (htmx:sendError).
// The 401 case is already handled above, so skip it here to avoid a double prompt.
function reportFailure(event) {
  if (event.detail.xhr && event.detail.xhr.status === 401) return;
  window.alert('Unable to complete the action. Please refresh and try again.');
}
document.body.addEventListener('htmx:responseError', reportFailure);
document.body.addEventListener('htmx:sendError', reportFailure);

// When htmx swaps in a server fragment, init any Alpine (x-data) it contains.
// No swapped fragment uses Alpine yet, but this keeps the two libraries composable.
document.body.addEventListener('htmx:afterSwap', (event) => {
  if (window.Alpine) window.Alpine.initTree(event.detail.target);
});

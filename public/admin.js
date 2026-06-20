// htmx + Alpine wiring for the admin panel.
//
// Real htmx (loaded in admin-head.hbs) drives the request/swap lifecycle from the
// hx-* attributes in the templates. This file adds the cross-cutting behaviours:
//   1. bounce to login when the admin session expires (401)
//   2. a styled confirm dialog in place of the browser's native confirm()
//   3. toast feedback on success / failure (replaces window.alert)
//   4. bring Alpine components inside server-swapped fragments to life

(function () {
  // ---- Toasts ---------------------------------------------------------------
  var toastHost = null;
  function ensureToastHost() {
    if (toastHost) return toastHost;
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
    return toastHost;
  }

  function showToast(message, type) {
    if (!message) return;
    var host = ensureToastHost();
    var el = document.createElement('div');
    el.className = 'toast toast-' + (type === 'error' ? 'error' : 'success');
    el.setAttribute('role', 'status');
    el.textContent = message;
    host.appendChild(el);
    // Force a reflow so the enter transition runs from the initial state.
    void el.offsetWidth;
    el.setAttribute('data-show', 'true');

    var timer = window.setTimeout(dismiss, type === 'error' ? 6000 : 3000);
    function dismiss() {
      window.clearTimeout(timer);
      el.removeAttribute('data-show');
      window.setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 250);
    }
    el.addEventListener('click', dismiss);
  }

  // ---- Styled confirm dialog ------------------------------------------------
  function showConfirm(question) {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.innerHTML =
        '<div class="modal" role="dialog" aria-modal="true">' +
        '<p class="modal-body"></p>' +
        '<div class="modal-actions">' +
        '<button type="button" class="btn btn-sm modal-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-sm btn-danger">Confirm</button>' +
        '</div></div>';
      overlay.querySelector('.modal-body').textContent = question;
      document.body.appendChild(overlay);

      var cancelBtn = overlay.querySelector('.modal-cancel');
      var confirmBtn = overlay.querySelector('.btn-danger');
      confirmBtn.focus();

      function close(result) {
        document.removeEventListener('keydown', onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(result);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(false);
        else if (e.key === 'Enter') close(true);
      }
      cancelBtn.addEventListener('click', function () {
        close(false);
      });
      confirmBtn.addEventListener('click', function () {
        close(true);
      });
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close(false);
      });
      document.addEventListener('keydown', onKey);
    });
  }

  // ---- htmx lifecycle -------------------------------------------------------
  // 401 means the admin cookie expired mid-session. htmx never swaps a non-2xx
  // response, so intercept before the (no-op) swap and redirect to login.
  document.body.addEventListener('htmx:beforeSwap', function (event) {
    if (event.detail.xhr.status === 401) {
      event.detail.shouldSwap = false;
      window.location.assign('/admin/login?expired=1');
    }
  });

  // htmx:confirm fires for every request; only intercept the ones that carry a
  // question (hx-confirm) and render a styled dialog instead of native confirm().
  // Requests without a question proceed untouched.
  document.body.addEventListener('htmx:confirm', function (event) {
    if (!event.detail.question) return;
    event.preventDefault();
    showConfirm(event.detail.question).then(function (ok) {
      if (ok) event.detail.issueRequest(true);
    });
  });

  // Success feedback: after a 2xx, surface the triggering control's data-toast.
  document.body.addEventListener('htmx:afterOnLoad', function (event) {
    var xhr = event.detail.xhr;
    if (!xhr || xhr.status < 200 || xhr.status >= 300) return;
    var elt = event.detail.elt;
    var msg = elt && elt.getAttribute ? elt.getAttribute('data-toast') : null;
    if (msg) showToast(msg, 'success');
  });

  // Any other non-2xx (htmx:responseError) or transport failure (htmx:sendError)
  // surfaces a toast. The 401 case is handled above, so skip it here.
  function reportFailure(event) {
    if (event.detail.xhr && event.detail.xhr.status === 401) return;
    showToast(
      'Unable to complete the action. Please refresh and try again.',
      'error',
    );
  }
  document.body.addEventListener('htmx:responseError', reportFailure);
  document.body.addEventListener('htmx:sendError', reportFailure);

  // When htmx swaps in a server fragment, init any Alpine (x-data) it contains.
  document.body.addEventListener('htmx:afterSwap', function (event) {
    if (window.Alpine) window.Alpine.initTree(event.detail.target);
  });
})();

document.addEventListener('click', async (event) => {
  if (!(event.target instanceof Element)) return;

  const trigger = event.target.closest('[hx-post], [hx-delete]');
  if (!trigger) return;

  const confirmMessage = trigger.getAttribute('hx-confirm');
  if (confirmMessage && !window.confirm(confirmMessage)) return;

  event.preventDefault();

  const method = trigger.hasAttribute('hx-delete') ? 'DELETE' : 'POST';
  const url =
    trigger.getAttribute(method === 'DELETE' ? 'hx-delete' : 'hx-post') ?? '';
  const targetSelector = trigger.getAttribute('hx-target');
  const target = targetSelector ? document.querySelector(targetSelector) : null;
  const loadingScope = target ?? trigger;

  loadingScope.classList.add('htmx-request');
  trigger.setAttribute('disabled', 'disabled');

  try {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'HX-Request': 'true' },
    });

    if (response.status === 401) {
      window.location.assign('/admin/login?expired=1');
      return;
    }

    if (!response.ok) {
      throw new Error(await response.text());
    }

    if (target && trigger.getAttribute('hx-swap') === 'outerHTML') {
      target.outerHTML = await response.text();
    }
  } catch {
    window.alert(
      'Unable to complete the action. Please refresh and try again.',
    );
  } finally {
    loadingScope.classList.remove('htmx-request');
    trigger.removeAttribute('disabled');
  }
});

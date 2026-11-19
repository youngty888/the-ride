/* Adds a "Show password" button under every password box on the page, so people can check what
   they typed. Tapping it again hides the password. Works on the RIDE and shop sign-in pages. */
(function () {
  'use strict';
  function addToggle(input) {
    if (input.dataset.showPwReady) return;
    input.dataset.showPwReady = '1';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Show password';
    btn.setAttribute('aria-pressed', 'false');
    btn.className = 'show-password-btn';
    btn.style.cssText = 'display:block;margin:.25rem 0 .5rem;padding:.25rem 0;background:none;border:0;' +
      'color:inherit;opacity:.8;font:inherit;font-size:.85rem;text-decoration:underline;cursor:pointer;';
    btn.addEventListener('click', function () {
      var showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show password' : 'Hide password';
      btn.setAttribute('aria-pressed', showing ? 'false' : 'true');
    });
    var anchor = input.closest('label') || input;
    anchor.insertAdjacentElement('afterend', btn);
  }
  function run() {
    document.querySelectorAll('input[type="password"]').forEach(addToggle);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();

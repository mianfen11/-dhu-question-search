export const preferenceKey = 'dhu-search-notice-dismissed-v1';
export function setupNotice({ dialog, help, confirm, remember, title, searchInput, storage }) {
  let returnFocus = searchInput;
  function read() { try { return storage()?.getItem(preferenceKey) === '1'; } catch { return false; } }
  function open(from) {
    if (dialog.open) return;
    returnFocus = from || searchInput;
    remember.checked = read(); // Manual reopening reflects, but never changes, the saved choice.
    dialog.showModal();
    document.body.classList.add('notice-open');
    title.focus();
  }
  function close() { dialog.close(); }
  function restore() {
    document.body.classList.remove('notice-open');
    if (returnFocus?.isConnected && !returnFocus.disabled) returnFocus.focus();
    else help.focus();
  }
  help.addEventListener('click', () => open(help));
  confirm.addEventListener('click', () => {
    try { if (remember.checked) storage()?.setItem(preferenceKey, '1'); else storage()?.removeItem(preferenceKey); } catch { /* Private mode/storage restrictions never block search. */ }
    close();
  });
  dialog.addEventListener('close', restore);
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return;
    if (event.shiftKey && [title, remember].includes(document.activeElement)) { event.preventDefault(); confirm.focus(); }
    else if (!event.shiftKey && document.activeElement === confirm) { event.preventDefault(); remember.focus(); }
  });
  // Native dialog makes the rest of the document inert and supports Escape/cancel.
  if (!read()) open(searchInput);
  return { open };
}

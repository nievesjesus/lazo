// Avisos breves (toast) y diálogo de confirmación, en lugar de alert()/confirm() del navegador.
import { esc } from './util';

export function toast(text: string, kind: 'info' | 'ok' | 'warn' = 'info', ms = 3500) {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

export function confirmDialog(title: string, body: string, confirmLabel: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'dialog-wrap';
    wrap.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t">
        <h3 id="dlg-t">${esc(title)}</h3>
        <p>${esc(body)}</p>
        <div class="dialog-actions">
          <button class="btn ghost" data-r="0">Cancelar</button>
          <button class="btn ${danger ? 'danger-solid' : ''}" data-r="1">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const close = (r: boolean) => { wrap.remove(); resolve(r); };
    wrap.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-r]');
      if (b) close(b.dataset.r === '1');
      else if (e.target === wrap) close(false);
    });
    wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(false); });
    document.body.appendChild(wrap);
    wrap.querySelector<HTMLButtonElement>('[data-r="0"]')!.focus();
  });
}

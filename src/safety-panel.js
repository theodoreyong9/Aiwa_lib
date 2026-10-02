// The part of a wallet's screen that keeps it from being lost — the same in every app that has an Aiwa wallet, so an app
// mounts it instead of writing its own:
//
//   mountWalletSafety(container, aiwa, { classes, sources, onRestored })
//
//   Recovery phrase   shown only when asked for, hidden again on demand, copyable. Never stored by this library. A wallet
//                     that came from a raw secret key (a Solana wallet imported as a key) has no phrase: its private
//                     key is what is shown instead, the same way.
//   Backup            a small file (the wallet's state, signed by its key) the owner keeps; restoring it brings the
//                     wallet back after connecting with the same phrase (aiwa.exportBackup / importBackup).
//   Sources           where else a state may come from, which the app provides: `{ label, fetch(aiwa) }`, where fetch
//                     resolves to `{ backup }` (as exportBackup made it) or `{ state }` (a wallet state, aiwa.adoptState),
//                     or null when the source holds nothing for this wallet. A registry that keeps what it derived from
//                     the wallet's submissions is one.
//
// DOM only, no dependency, nothing but textContent written (a phrase or a message is never parsed as HTML). Styling is
// minimal and inherits the page's colours; `classes` ({ button, box, note }) lets an app dress it in its own.

const BUTTON = 'font:inherit;padding:4px 10px;border:1px solid rgba(128,128,128,.4);background:transparent;color:inherit;border-radius:8px;cursor:pointer;margin:0 6px 6px 0';
const BOX = 'padding:8px 10px;border:1px dashed rgba(128,128,128,.5);border-radius:8px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere;user-select:all;margin:0 0 8px';
const NOTE = 'font-size:12.5px;opacity:.75;margin:0 0 8px;overflow-wrap:anywhere';

/**
 * @param {HTMLElement} container where to put it (emptied first)
 * @param {import('./wallet.js').AIWA} aiwa a connected wallet
 * @param {{ classes?: { button?: string, box?: string, note?: string }, sources?: Array<{ label: string, fetch: (aiwa: object) => Promise<object|null> }>, onRestored?: (result: object) => void }} [options]
 * @returns {{ unmount: () => void }}
 */
export function mountWalletSafety(container, aiwa, { classes = {}, sources = [], onRestored } = {}) {
  const doc = container.ownerDocument;
  const make = (tag, { text, cls, style, attrs } = {}) => {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (cls) el.className = cls;
    else if (style) el.style.cssText = style;
    for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
    return el;
  };
  const button = (text, onClick) => {
    const b = make('button', { text, cls: classes.button, style: BUTTON, attrs: { type: 'button' } });
    b.addEventListener('click', onClick);
    return b;
  };
  const note = (text) => make('div', { text, cls: classes.note, style: NOTE });
  const say = (text) => { status.textContent = text; };

  container.replaceChildren();
  const status = make('div', { cls: classes.note, style: NOTE, attrs: { role: 'status' } });

  // --- recovery phrase (or, for a wallet that came from a key, the key) ---
  const secretOf = () => (aiwa.recoveryPhrase ? { text: aiwa.recoveryPhrase, noun: 'recovery phrase' } : aiwa.recoveryKey ? { text: aiwa.recoveryKey, noun: 'private key' } : null);
  const phraseBox = make('div', { cls: classes.box, style: BOX });
  phraseBox.hidden = true;
  const copyButton = button('Copy', async () => {
    try { await navigator.clipboard.writeText(secretOf().text); say('Copied.'); } catch { say('Could not copy: select it and copy it.'); }
  });
  copyButton.hidden = true;
  const initial = secretOf();
  const label = (shown) => `${shown ? 'Hide' : 'Show'} ${initial ? initial.noun : 'recovery phrase'}`;
  const hide = () => { phraseBox.hidden = true; phraseBox.textContent = ''; copyButton.hidden = true; showButton.textContent = label(false); };
  const showButton = button(label(false), () => {
    if (!phraseBox.hidden) { hide(); return; }
    const secret = secretOf();
    if (!secret) { say('This wallet has neither a phrase nor a key to show. Use a backup.'); return; }
    phraseBox.textContent = secret.text;
    phraseBox.hidden = false;
    copyButton.hidden = false;
    showButton.textContent = label(true);
    say(secret.noun === 'private key' ? 'This wallet was made from a key, not a phrase: this key is what to keep. Import it to log back in (here, or in any Solana wallet).' : '');
  });

  // --- backup / restore ---
  const download = button('Download backup', async () => {
    try {
      const backup = await aiwa.exportBackup();
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
      const link = make('a', { attrs: { href: url, download: `aiwa-backup-${String(aiwa.address).slice(0, 6)}-epoch${backup.epoch}.json` } });
      doc.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      say(`Backup saved (epoch ${backup.epoch}). Keep the file; the phrase and the file together bring this wallet back.`);
    } catch (err) { say(`Backup failed: ${err.message}`); }
  });
  const picker = make('input', { attrs: { type: 'file', accept: 'application/json,.json' } });
  picker.hidden = true;
  const report = (result, from) => {
    const restored = result.restored ?? result.adopted;
    say(restored ? `Restored from ${from}: epoch ${result.epoch}.` : `Nothing to restore from ${from}: this wallet is already at epoch ${result.epoch} or further.`);
    if (restored && onRestored) onRestored(result);
  };
  picker.addEventListener('change', async () => {
    const file = picker.files && picker.files[0];
    picker.value = '';
    if (!file) return;
    try { report(await aiwa.importBackup(JSON.parse(await file.text())), 'the file'); } catch (err) { say(`Restore failed: ${err.message}`); }
  });
  const restore = button('Restore from backup file', () => picker.click());

  const row = (...els) => { const r = make('div'); r.append(...els); return r; };
  const parts = [
    note(`Your ${initial ? initial.noun : 'recovery phrase'} is the only way to log back in. Write it down and keep it private: whoever has it controls this wallet.`),
    row(showButton, copyButton), phraseBox,
    note('A backup brings your history back (mining, claimed AIWA) after you log back in.'),
    row(download, restore, picker),
  ];
  for (const source of sources) {
    parts.push(row(button(`Restore from ${source.label}`, async () => {
      say(`Looking in ${source.label}…`);
      try {
        const got = await source.fetch(aiwa);
        if (!got) { say(`${source.label} holds nothing for this wallet.`); return; }
        report(got.backup ? await aiwa.importBackup(got.backup) : await aiwa.adoptState(got.state), source.label);
      } catch (err) { say(`Restore failed: ${err.message}`); }
    })));
  }
  parts.push(status);
  container.append(...parts);

  return { unmount() { hide(); container.replaceChildren(); } };
}

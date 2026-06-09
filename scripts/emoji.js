// Shared emoji palette + picker builder.
// Loaded both as a content script (ISOLATED world, before content.js) and in
// extension pages via <script src="../scripts/emoji.js">. Exposes window.S2Emoji.
//
// To add categories/emojis, just extend EMOJI_GROUPS — both the on-map picker
// and the manager page pick it up automatically.
(function (root) {
  'use strict';

  const DEFAULT_EMOJI = '📍';

  const EMOJI_GROUPS = [
    { label: 'Pin',       emojis: ['📍', '🚩', '⭐', '❗'] },
    { label: 'Medals',    emojis: ['🥇', '🥈', '🥉', '🏅', '🎖️', '🏆'] },
    { label: 'Religious', emojis: ['✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '⛩️', '🛐', '🕌', '🕍', '⛪', '🛕'] },
    { label: 'Sport',     emojis: ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🥏', '🎱', '🏓', '🏸', '🥊', '🥋', '⛳', '🎯', '🏌️', '🏄', '🚴', '🏊'] }
  ];

  // Builds a grouped emoji palette element. onPick(emoji) fires on selection.
  // Class names are shared (s2-emoji-*); each context styles them in its own CSS.
  function buildEmojiPicker(selected, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 's2-emoji-picker';
    EMOJI_GROUPS.forEach(group => {
      const label = document.createElement('div');
      label.className = 's2-emoji-label';
      label.textContent = group.label;
      wrap.appendChild(label);
      const row = document.createElement('div');
      row.className = 's2-emoji-row';
      group.emojis.forEach(em => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 's2-emoji-btn' + (em === selected ? ' selected' : '');
        btn.textContent = em;
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          wrap.querySelectorAll('.s2-emoji-btn.selected').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          onPick(em);
        });
        row.appendChild(btn);
      });
      wrap.appendChild(row);
    });
    return wrap;
  }

  root.S2Emoji = { DEFAULT_EMOJI, EMOJI_GROUPS, buildEmojiPicker };
})(typeof window !== 'undefined' ? window : this);

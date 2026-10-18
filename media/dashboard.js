// Extension Loadout 대시보드(웹뷰). 확장이 보낸 데이터를 표로 그리고, 바꾸는 요청은 모두 확장으로 보낸다.
// 확장 이름·설명 같은 문자열은 매니페스트에서 온 값이므로 textContent로만 넣는다.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');
  const S = JSON.parse(decodeURIComponent(app.dataset.strings));
  const DEFAULT_ICON = app.dataset.defaultIcon;
  const saved = vscode.getState() || {};
  const ui = { filter: saved.filter || 'all', search: saved.search || '', sort: saved.sort || 'name', dir: saved.dir || 1, selected: new Set() };
  let data;

  const persist = () => vscode.setState({ filter: ui.filter, search: ui.search, sort: ui.sort, dir: ui.dir });
  const post = (m) => vscode.postMessage(m);
  const command = (c) => post({ type: 'command', command: c });
  const fmt = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : b >= 1024 ** 2 ? Math.round(b / 1024 ** 2) + ' MB' : b > 0 ? Math.max(1, Math.round(b / 1024)) + ' KB' : '');
  const fill = (s, ...a) => a.reduce((acc, v, i) => acc.replace(`{${i}}`, v), s);

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === false || v === null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'checked' || k === 'disabled' || k === 'indeterminate') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat()) if (c !== undefined && c !== null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'data') {
      data = e.data.data;
      render();
    }
  });
  post({ type: 'ready' });

  const FILTERS = [
    ['all', S.all, () => true],
    ['running', S.running, (r) => r.running],
    ['always', S.always, (r) => r.startsAlways],
    ['memory', S.memory, (r) => r.memory > 0],
    ['suggested', S.suggested, (r) => !!(r.suggestion || r.learned)],
    ['changed', S.changed, (r) => r.here !== 'global'],
  ];
  const SORTS = {
    name: (a, b) => a.name.localeCompare(b.name),
    here: (a, b) => ['on', 'off', 'global'].indexOf(a.here) - ['on', 'off', 'global'].indexOf(b.here) || a.name.localeCompare(b.name),
    memory: (a, b) => a.memory - b.memory || a.name.localeCompare(b.name),
    starts: (a, b) => Number(b.startsAlways) - Number(a.startsAlways) || a.starts.localeCompare(b.starts),
    now: (a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name),
  };

  function visibleRows() {
    if (!data) return [];
    const f = FILTERS.find((x) => x[0] === ui.filter)[2];
    const q = ui.search.trim().toLowerCase();
    const rows = data.rows.filter((r) => f(r) && (!q || r.name.toLowerCase().includes(q) || r.id.includes(q) || (r.description || '').toLowerCase().includes(q)));
    const cmp = SORTS[ui.sort] || SORTS.name;
    return rows.sort((a, b) => cmp(a, b) * (ui.sort === 'memory' ? -ui.dir : ui.dir));
  }

  function banner(kind, text, ...buttons) {
    return h('div', { class: `banner ${kind}` }, h('span', { class: 'banner-text' }, text), ...buttons);
  }
  const button = (label, onclick, primary) => h('button', { class: primary ? 'primary' : '', onclick }, label);

  function render() {
    // 검색창 포커스를 지키며 다시 그린다.
    const focused = document.activeElement && document.activeElement.id === 'search';
    const caret = focused ? document.activeElement.selectionStart : 0;
    app.replaceChildren();
    if (!data) return;
    const rows = visibleRows();
    for (const id of [...ui.selected]) if (!data.rows.some((r) => r.id === id)) ui.selected.delete(id);

    app.append(
      h(
        'header',
        {},
        h('h1', {}, 'Extension Loadout', h('span', { class: 'folder' }, data.folder)),
        h('span', { class: 'muted' }, data.totalMemory ? fill(S.total, data.totalMemory) : ''),
        h('span', { class: 'spacer' }),
        button(S.openFile, () => command('extensionLoadout.openConfig')),
        button(S.refresh, () => post({ type: 'refresh' })),
      ),
    );
    for (const e of data.errors) app.append(banner('error', e, button(S.openFile, () => command('extensionLoadout.openConfig'))));
    for (const c of data.conflicts) app.append(banner('warn', c));
    if (data.scheduled) {
      app.append(banner('info', S.scheduled, button(S.applyNow, () => command('extensionLoadout.applyAndRestart'), true), button(S.cancel, () => command('extensionLoadout.cancelApplyOnQuit'))));
    } else if (data.pending) {
      app.append(banner('pending', S.pending, button(S.applyNow, () => command('extensionLoadout.applyAndRestart'), true), button(S.applyOnQuit, () => command('extensionLoadout.applyOnQuit'))));
    }
    if (data.pressure) app.append(banner('warn', `${S.memoryTight} · ${data.pressure.detail}`, button(S.restartHost, () => command('extensionLoadout.restartExtensionHost'))));

    const search = h('input', {
      id: 'search',
      type: 'search',
      placeholder: S.search,
      value: ui.search,
      oninput: (e) => {
        ui.search = e.target.value;
        persist();
        render();
      },
    });
    const chips = FILTERS.map(([key, label, f]) =>
      h(
        'button',
        {
          class: `chip ${ui.filter === key ? 'active' : ''}`,
          onclick: () => {
            ui.filter = key;
            persist();
            render();
          },
        },
        label,
        h('span', { class: 'count' }, String(data.rows.filter(f).length)),
      ),
    );
    app.append(h('div', { class: 'toolbar' }, search, ...chips));

    if (ui.selected.size) {
      const ids = [...ui.selected];
      const act = (value) => () => {
        post({ type: 'set', ids, value });
        ui.selected.clear();
        render();
      };
      app.append(
        h(
          'div',
          { class: 'bulk' },
          h('strong', {}, fill(S.selected, ids.length)),
          button(S.turnOff, act('off'), true),
          button(S.turnOn, act('on')),
          button(S.sameAsGlobal, act('global')),
          button(S.clear, () => {
            ui.selected.clear();
            render();
          }),
        ),
      );
    }

    const selectable = rows.filter((r) => !r.locked && !r.builtin);
    const allChecked = selectable.length > 0 && selectable.every((r) => ui.selected.has(r.id));
    const th = (key, label, cls) =>
      h(
        'th',
        {
          class: `${cls || ''} ${key ? 'sortable' : ''} ${ui.sort === key ? 'sorted' : ''}`,
          onclick: key
            ? () => {
                ui.dir = ui.sort === key ? -ui.dir : 1;
                ui.sort = key;
                persist();
                render();
              }
            : undefined,
        },
        label,
        ui.sort === key ? (ui.dir > 0 === (key !== 'memory') ? ' ▲' : ' ▼') : '',
      );
    const table = h(
      'table',
      {},
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h(
            'th',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: allChecked,
              title: S.all,
              onchange: (e) => {
                for (const r of selectable) e.target.checked ? ui.selected.add(r.id) : ui.selected.delete(r.id);
                render();
              },
            }),
          ),
          th('name', S.extension),
          th('here', S.here),
          th(undefined, S.global),
          th('starts', S.starts),
          th('now', S.now),
          th('memory', S.mem, 'num'),
          th(undefined, S.why),
        ),
      ),
      h('tbody', {}, rows.length ? rows.map(row) : h('tr', {}, h('td', { colspan: 8, class: 'empty' }, S.noRows))),
    );
    app.append(table);

    app.append(
      h(
        'footer',
        {},
        data.canUndo ? button(S.undo, () => command('extensionLoadout.undo')) : '',
        button(S.otherFolders, () => command('extensionLoadout.applyToOtherFolders')),
        button(S.savePreset, () => command('extensionLoadout.savePreset')),
        button(S.applyPreset, () => command('extensionLoadout.applyPreset')),
        button(S.suggest, () => command('extensionLoadout.suggest')),
        button(S.reset, () => command('extensionLoadout.resetToGlobal')),
        h('span', { class: 'spacer' }),
        button(S.restartHost, () => command('extensionLoadout.restartExtensionHost')),
      ),
    );

    if (focused) {
      const s = document.getElementById('search');
      s.focus();
      s.setSelectionRange(caret, caret);
    }
  }

  function row(r) {
    const segment = (value, label) =>
      h(
        'button',
        {
          class: `seg ${value} ${r.here === value ? 'active' : ''}`,
          disabled: r.locked || r.builtin,
          title: label,
          onclick: () => r.here !== value && post({ type: 'set', ids: [r.id], value }),
        },
        label,
      );
    const why = [];
    if (r.suggestion) why.push(h('span', { class: 'tag suggestion', title: r.suggestion }, '💡 ' + S.suggestion));
    if (r.learned) why.push(h('span', { class: 'tag learned', title: r.learned }, '↺ ' + S.learned));
    if (r.recommendedByRepo) why.push(h('span', { class: 'tag repo' }, '★ ' + S.repo));
    if (r.locked) why.push(h('span', { class: 'tag' }, S.locked));
    if (r.builtin) why.push(h('span', { class: 'tag' }, S.builtin));
    if (r.via) why.push(h('code', {}, r.via));
    if (r.note) why.push(h('span', { class: 'note' }, '“' + r.note + '”'));
    const now = r.mismatch ? h('span', { class: 'warn' }, '⚠ ' + (r.desiredOn ? S.mismatchOn : S.mismatchOff)) : r.active ? h('span', { class: 'running' }, '● ' + S.isRunning) : r.running ? S.loaded : S.notLoaded;
    return h(
      'tr',
      { class: `${r.here} ${r.desiredOn ? '' : 'dim'} ${ui.selected.has(r.id) ? 'selected' : ''}` },
      h(
        'td',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: ui.selected.has(r.id),
          disabled: r.locked || r.builtin,
          onchange: (e) => {
            e.target.checked ? ui.selected.add(r.id) : ui.selected.delete(r.id);
            render();
          },
        }),
      ),
      h(
        'td',
        { class: 'ext' },
        h('img', { src: r.icon || DEFAULT_ICON, alt: '' }),
        h('div', {}, h('a', { href: '#', onclick: (e) => (e.preventDefault(), post({ type: 'open', id: r.id })), title: r.description || '' }, r.name), h('div', { class: 'id' }, r.id)),
      ),
      h('td', { class: 'here' }, h('div', { class: 'segments' }, segment('on', S.on), segment('global', S.follow), segment('off', S.off))),
      h('td', {}, r.globallyEnabled ? S.onGlobally : S.offGlobally),
      h('td', { class: `starts ${r.startsAlways ? 'always' : ''}` }, r.starts),
      h('td', { class: 'now' }, now),
      h('td', { class: `num ${data.heavy && r.memory >= data.heavy ? 'heavy' : ''}`, title: r.processes ? `${r.processes} ${S.processes} · ${S.allWindows} ${fmt(r.allWindowsMemory)}` : '' }, fmt(r.memory)),
      h('td', { class: 'why' }, why),
    );
  }
})();

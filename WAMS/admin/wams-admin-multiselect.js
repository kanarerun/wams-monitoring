/* ────────────────────────────────────────────────────────────────
   wams-admin-multiselect.js
   Lightweight multi-checkbox dropdown used for the grouped
   Year Level / Section pickers on the admin pages.

   Usage:
     const ms = createMultiSelect({
       mountId: 'yearMultiselect',
       placeholder: '-- Select a year level --',
       onChange: values => { ... }
     });
     ms.setOptions([{ value: '1st Year', label: '1st Year' }]);
     ms.setValues(['1st Year']);
     ms.getValues();
   ──────────────────────────────────────────────────────────────── */
(function(){
  const CHECK_ICON = '<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>';

  function el(tag, cls, html){
    const node = document.createElement(tag);
    if(cls) node.className = cls;
    if(html != null) node.innerHTML = html;
    return node;
  }

  function createMultiSelect(options){
    const opts = Object.assign({
      mountId: '',
      mount: null,
      placeholder: '-- Select --',
      onChange: null,
      disabled: false
    }, options || {});

    const host = opts.mount || (opts.mountId ? document.getElementById(opts.mountId) : null);
    if(!host) return null;

    let items = [];        // [{ value, label }]
    let selected = [];     // [value]
    let open = false;

    host.classList.add('ms');
    host.innerHTML = '';

    const toggle = el('button', 'ms-toggle');
    toggle.type = 'button';
    toggle.innerHTML = '<span class="ms-text"></span>' +
      '<svg class="ms-caret" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>';
    const toggleText = toggle.querySelector('.ms-text');

    const panel = el('div', 'ms-panel');

    host.appendChild(toggle);
    host.appendChild(panel);

    function labelFor(value){
      const found = items.find(i => String(i.value) === String(value));
      return found ? found.label : String(value);
    }

    function summary(){
      if(!selected.length) return opts.placeholder;
      return selected.map(labelFor).join(', ');
    }

    function render(){
      toggleText.textContent = summary();
      toggleText.style.color = selected.length ? '' : 'var(--tx3)';
      toggle.disabled = !!opts.disabled || items.length === 0;
      toggle.classList.toggle('is-empty', selected.length === 0);

      panel.innerHTML = '';
      if(!items.length){
        panel.appendChild(el('div', 'ms-empty', 'No options available'));
        return;
      }
      items.forEach(item => {
        const isChecked = selected.some(v => String(v) === String(item.value));
        const row = el('div', 'ms-opt' + (isChecked ? ' checked' : ''),
          '<span class="ms-box">' + CHECK_ICON + '</span><span>' + escapeHtml(item.label) + '</span>');
        row.setAttribute('role', 'checkbox');
        row.setAttribute('aria-checked', isChecked ? 'true' : 'false');
        row.addEventListener('click', event => {
          event.stopPropagation();
          toggleValue(item.value);
        });
        panel.appendChild(row);
      });
    }

    function toggleValue(value){
      const idx = selected.findIndex(v => String(v) === String(value));
      if(idx === -1) selected.push(value);
      else selected.splice(idx, 1);
      render();
      if(typeof opts.onChange === 'function') opts.onChange(selected.slice());
    }

    function close(){
      if(!open) return;
      open = false;
      host.classList.remove('open');
      document.removeEventListener('click', onOutside);
      document.removeEventListener('keydown', onKey);
    }

    function onOutside(event){
      if(!host.contains(event.target)) close();
    }

    function onKey(event){
      if(event.key === 'Escape') close();
    }

    function openPanel(){
      if(open || toggle.disabled) return;
      // Close any other open multi-select so panels never overlap
      document.querySelectorAll('.ms.open').forEach(node => {
        if(node !== host) node.classList.remove('open');
      });
      open = true;
      host.classList.add('open');
      document.addEventListener('click', onOutside);
      document.addEventListener('keydown', onKey);
    }

    toggle.addEventListener('click', event => {
      event.stopPropagation();
      if(open) close();
      else openPanel();
    });

    function escapeHtml(value){
      const div = document.createElement('div');
      div.textContent = value == null ? '' : String(value);
      return div.innerHTML;
    }

    const api = {
      /** Replace the available options. Values that disappear are unselected. */
      setOptions(nextItems, keepSelection){
        items = (nextItems || []).map(item => ({
          value: item.value,
          label: item.label == null ? String(item.value) : String(item.label)
        }));
        if(keepSelection){
          selected = selected.filter(value => items.some(item => String(item.value) === String(value)));
        } else {
          selected = [];
        }
        render();
        return api;
      },
      setValues(values){
        selected = (values || []).slice();
        render();
        return api;
      },
      getValues(){ return selected.slice(); },
      getLabels(){ return selected.map(labelFor); },
      getOptions(){ return items.slice(); },
      setDisabled(flag){
        opts.disabled = !!flag;
        render();
        return api;
      },
      setPlaceholder(text){
        opts.placeholder = text;
        render();
        return api;
      },
      clear(){
        selected = [];
        render();
        return api;
      },
      close,
      render
    };

    render();
    return api;
  }

  window.createMultiSelect = createMultiSelect;
})();

export function render({ row, bindings, ui }) {
  const title = ui.escapeHtml(row.fields.title);
  const handle = ui.escapeHtml(row.fields.handle);
  const done = row.fields.done === true;
  return `<article class="item-tile">
    <header class="item-tile__header">
      <div class="item-tile__identity">
        <h3 class="item-tile__title">${title}</h3>
        <p class="item-tile__handle">${handle}</p>
      </div>
      <span class="item-tile__status${done ? ' item-tile__status--done' : ''}">${done ? 'Done' : 'Open'}</span>
    </header>
    <div class="item-tile__controls">
      <div class="item-tile__edit">${bindings.edit}</div>
      <div class="item-tile__delete">${bindings.delete}</div>
    </div>
  </article>`;
}

export function mount(root, presentation) {
  root.setAttribute("data-enhanced", "true");
  return () => root.removeAttribute("data-enhanced");
}

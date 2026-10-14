export function render({ row, bindings, ui }) {
  return bindings.card;
}

export function mount(root, presentation) {
  root.setAttribute("data-enhanced", "true");
  return () => {
    root.removeAttribute("data-enhanced");
  };
}

import SidebarNavButton from "./SidebarNavButton";

export default function Sidebar({ brand, items, activeItemId, onSelectItem }) {
  return (
    <aside className="operator-sidebar">
      <p className="sidebar-brand">{brand}</p>
      <nav className="sidebar-nav" aria-label="Secciones del operador">
        {items.map((item) => (
          <SidebarNavButton
            key={item.id}
            id={item.id}
            label={item.label}
            isActive={activeItemId === item.id}
            onSelect={onSelectItem}
          />
        ))}
      </nav>
    </aside>
  );
}

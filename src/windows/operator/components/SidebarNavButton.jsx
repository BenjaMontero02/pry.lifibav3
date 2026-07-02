export default function SidebarNavButton({ id, label, isActive, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      className={`sidebar-link ${isActive ? "sidebar-link-active" : ""}`}
    >
      {label}
    </button>
  );
}

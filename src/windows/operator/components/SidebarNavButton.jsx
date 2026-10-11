export default function SidebarNavButton({ id, label, isActive, onSelect }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-current={isActive ? "page" : undefined}
      className={`sidebar-link ${isActive ? "sidebar-link-active" : ""}`}
    >
      {label}
    </button>
  );
}

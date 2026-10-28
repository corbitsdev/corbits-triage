type IconProps = { className?: string };

function Icon({ className, children, size }: IconProps & { children: React.ReactNode; size?: number }) {
  const style = size === undefined ? undefined : { width: size, height: size };
  return (
    <svg className={className ? `ic ${className}` : "ic"} viewBox="0 0 16 16" style={style} aria-hidden="true">
      {children}
    </svg>
  );
}

export function SearchIcon() {
  return <Icon><circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3.5 3.5" /></Icon>;
}
export function FilterIcon() {
  return <Icon><path d="M2 3.5h12M4.5 8h7M7 12.5h2" /></Icon>;
}
export function ChevronIcon() {
  return <Icon className="chev"><path d="m6 3.5 4.5 4.5L6 12.5" /></Icon>;
}
export function ExternalIcon() {
  return <Icon size={13}><path d="M6 3H3v10h10v-3M9 2.5h4.5V7M13.5 2.5 7 9" /></Icon>;
}
export function CheckIcon() {
  return <Icon><path d="m3 8.5 3 3 7-7" /></Icon>;
}
export function InboxIcon() {
  return <Icon><path d="M2 9.5 4 3h8l2 6.5V13H2zM2 9.5h3.5l1 1.5h3l1-1.5H14" /></Icon>;
}
export function ReviewIcon() {
  return <Icon><path d="M3 2.5h7l3 3V13.5H3zM10 2.5V6h3M5 8.5l1.5 1.5L11 6" /></Icon>;
}
export function RepoIcon() {
  return <Icon><path d="M3.5 2.5h9v11h-9zM6 2.5v11" /></Icon>;
}
export function GearIcon() {
  return <Icon><circle cx="8" cy="8" r="2.2" /><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" /></Icon>;
}
export function SignOutIcon() {
  return <Icon><path d="M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6.5" /></Icon>;
}
export function UpDownIcon() {
  return <Icon className="updown" size={14}><path d="m5 6 3-3 3 3M5 10l3 3 3-3" /></Icon>;
}
export function CloseIcon() {
  return <Icon><path d="m4 4 8 8M12 4l-8 8" /></Icon>;
}

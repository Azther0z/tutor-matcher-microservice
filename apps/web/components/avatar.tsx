const TONES = ["#2f6f5e", "#4a5fa8", "#8a5a9e", "#a3643b", "#3f7f8c", "#8c4a5a"];

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/** A round profile picture. Shows the image when there is one, otherwise the person's initials on a steady color. */
export function Avatar({ name, src, size = 36 }: { name: string; src?: string | null; size?: number }) {
  const tone = TONES[[...name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % TONES.length];
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: src ? "transparent" : tone }}
    >
      {src ? <img src={src} alt="" /> : initials(name)}
    </span>
  );
}

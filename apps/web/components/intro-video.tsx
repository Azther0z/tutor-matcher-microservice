/** Shows an introduction video inline: YouTube and Vimeo as frames, direct files as a player, anything else as a link. */
function embedUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return `https://www.youtube-nocookie.com/embed/${url.pathname.slice(1)}`;
    if (host === "youtube.com" || host === "m.youtube.com") {
      const id = url.searchParams.get("v") ?? (url.pathname.startsWith("/embed/") || url.pathname.startsWith("/shorts/") ? url.pathname.split("/")[2] : null);
      return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
    }
    if (host === "vimeo.com") {
      const id = url.pathname.split("/").filter(Boolean)[0];
      return id && /^\d+$/.test(id) ? `https://player.vimeo.com/video/${id}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

export function IntroVideo({ url }: { url: string }) {
  const embed = embedUrl(url);
  if (embed) {
    return (
      <div className="intro-video">
        <iframe src={embed} title="Introduction video" allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />
      </div>
    );
  }
  if (/\.(mp4|webm|mov)(\?|$)/i.test(url)) {
    return (
      <div className="intro-video">
        <video src={url} controls preload="metadata" />
      </div>
    );
  }
  return (
    <a className="text-link" href={url} rel="noreferrer" target="_blank">
      Watch intro video
    </a>
  );
}

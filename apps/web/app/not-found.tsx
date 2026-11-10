import Link from "next/link";

export default function NotFound() {
  return <section className="panel not-found"><p className="eyebrow">PAGE NOT FOUND</p><h1>We couldn’t find that page</h1><p>The link may be old or mistyped. Head back home or look for a tutor.</p><div className="button-row"><Link className="button" href="/">Go home</Link><Link className="button button-outline" href="/discover">Find tutors</Link></div></section>;
}

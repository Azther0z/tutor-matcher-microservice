import Link from "next/link";
import { HomeActions } from "@/components/home-actions";

const paths = [
  { tag: "1", title: "Find a tutor", text: "Browse online tutors approved by our team." },
  { tag: "2", title: "Book a time", text: "Pick a half-hour slot and see the total before you confirm." },
  { tag: "3", title: "Learn and review", text: "Message your tutor, take the lesson, then leave a review." },
];

export default function HomePage() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <h1 id="hero-title">Make your next lesson <em>count.</em></h1>
        <p className="hero-lede">Meet tutors who understand how you learn. Build a steady rhythm, ask better questions, and make progress you can see.</p>
        <form className="hero-search" action="/discover" role="search">
          <label className="sr-only" htmlFor="hero-q">What do you want to learn?</label>
          <input id="hero-q" name="q" type="search" placeholder="What do you want to learn?" autoComplete="off" />
          <button className="button" type="submit">Search</button>
        </form>
        <HomeActions />
      </section>

      <section className="feature-band" aria-labelledby="how-title">
        <h2 id="how-title">How Tutor Matcher works</h2>
        <div className="card-grid">
          {paths.map((item) => (
            <article className="path-card" key={item.tag}>
              <span className="path-no">{item.tag}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <aside className="promo-banner" aria-label="Get started">
        <strong>Not sure where to start? Browse tutors for free.</strong>
        <span className="promo-actions">
          <Link className="button button-ghost" href="/discover">Find tutors</Link>
          <Link className="button button-light" href="/signup">Create account</Link>
        </span>
      </aside>
    </>
  );
}

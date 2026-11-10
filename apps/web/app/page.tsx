import Link from "next/link";

const paths = [
  { tag: "STEP 1", title: "Search approved tutors", text: "Browse online tutors who have been reviewed and approved by our team." },
  { tag: "STEP 2", title: "Book a half-hour slot", text: "Pick the times that suit you and see the estimated total before you confirm." },
  { tag: "STEP 3", title: "Learn and review", text: "Message your tutor, finish the lesson, and leave a review to help the next learner." },
];

export default function HomePage() {
  return (
    <>
      <section className="hero" aria-labelledby="hero-title">
        <p className="eyebrow">A better fit for every learning goal</p>
        <h1 id="hero-title">Make your next lesson <em>count.</em></h1>
        <p className="hero-lede">Meet tutors who understand how you learn. Build a steady rhythm, ask better questions, and make progress you can see.</p>
        <form className="hero-search" action="/discover" role="search">
          <label className="sr-only" htmlFor="hero-q">What do you want to learn?</label>
          <input id="hero-q" name="q" type="search" placeholder="What do you want to learn?" autoComplete="off" />
          <button className="button" type="submit">Search</button>
        </form>
        <div className="actions">
          <Link className="button button-outline" href="/signup">Get started <span aria-hidden="true">→</span></Link>
          <Link className="button button-quiet" href="/teach/application">Become a tutor</Link>
          <Link className="text-link" href="/login">I already have an account</Link>
        </div>
        <p className="hero-footnote">Every new account starts with student access.</p>
      </section>

      <section className="feature-band" aria-labelledby="how-title">
        <h2 id="how-title">How Tutor Matcher works</h2>
        <div className="card-grid">
          {paths.map((item) => (
            <article className="path-card" key={item.tag}>
              <span className="tiny-label">{item.tag}</span>
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

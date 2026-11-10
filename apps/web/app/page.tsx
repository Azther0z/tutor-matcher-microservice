import Link from "next/link";

const steps = [
  { title: "Search tutors", text: "Browse online tutors who our team has reviewed and approved." },
  { title: "Book a time", text: "Pick a day and a half-hour slot, and see the total before you confirm." },
  { title: "Learn and review", text: "Message your tutor, join the lesson, then leave a review." },
];

export default function HomePage() {
  return (
    <>
      <section className="home-hero" aria-labelledby="hero-title">
        <h1 id="hero-title">Find a tutor and book your next lesson</h1>
        <p>Approved tutors, online lessons, and prices you can see before you book.</p>
        <form className="hero-search" action="/discover" role="search">
          <label className="sr-only" htmlFor="hero-q">What do you want to learn?</label>
          <input id="hero-q" name="q" type="search" placeholder="What do you want to learn?" autoComplete="off" />
          <button className="button" type="submit">Search</button>
        </form>
        <div className="home-links">
          <Link className="text-link" href="/discover">Browse all tutors</Link>
          <Link className="text-link" href="/teach/application">Become a tutor</Link>
        </div>
      </section>

      <section className="home-steps" aria-labelledby="how-title">
        <h2 id="how-title">How it works</h2>
        <div className="home-step-grid">
          {steps.map((item, index) => (
            <article className="panel home-step" key={item.title}>
              <span className="home-step-no">{index + 1}</span>
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="panel home-cta" aria-label="Get started">
        <span>
          <strong>New here?</strong>
          <small>Every account starts with student access.</small>
        </span>
        <span className="home-cta-actions">
          <Link className="text-link" href="/login">Log in</Link>
          <Link className="button" href="/signup">Create account</Link>
        </span>
      </section>
    </>
  );
}

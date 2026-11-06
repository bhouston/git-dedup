import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './index.module.css';

const cards = [
  {
    number: '6x',
    title: 'Faster checkouts',
    body: 'Repeat clones, worktrees, and submodules reuse history already on disk. Large checkouts drop from over a minute to about 10 seconds.',
  },
  {
    number: '70%',
    title: 'Less disk space',
    body: 'Every checkout shares one copy of Git history. Across 117 checkouts, Git data dropped from 35.5 GB to 11.1 GB.',
  },
  {
    number: '0',
    title: 'Changes to your workflow',
    body: 'Checkouts are normal Git repositories. Use git, your editor, and your agents exactly as before.',
  },
];

export default function Home() {
  return (
    <Layout
      title="Faster checkouts, a fraction of the disk space"
      description="git-dedup shares one copy of Git history across all your clones, worktrees, and submodules. Checkouts are 6x faster and use 70% less disk."
    >
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.copy}>
            <h1>
              Faster checkouts.
              <br />
              <em>A fraction of the disk space.</em>
            </h1>
            <p className={styles.lead}>
              git-dedup is a wrapper around <code>git</code> built for fleets of coding agents. It forwards ordinary Git
              commands unchanged and automatically keeps one shared copy of Git history, so every new clone, worktree,
              and submodule reuses what is already on disk instead of downloading it again.
            </p>
            <pre className={styles.example}>
              <code>{`npm install -g git-dedup

# check out a new repo automatically using the dedup store
git-dedup clone https://github.com/you/project.git

# dedup an existing repo into the store
git-dedup store add ./my-existing-repo`}</code>
            </pre>
            <p className={styles.performance}>
              That's it. git-dedup automatically consolidates the new or existing project's history into a shared store
              in <code>~/.git-dedup</code> or if its history already existed there, it reuses it automatically. The
              checkout is a normal Git repository, so keep using <code>git</code> as usual.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} to="/docs">
                Get started <span aria-hidden="true">↗</span>
              </Link>
              <Link className={styles.secondary} to="/docs/agents">
                Set up your agents <span aria-hidden="true">→</span>
              </Link>
            </div>
            <p className={styles.platform}>Native binary · macOS, Linux, and Windows</p>
          </div>
        </div>
      </header>
      <main>
        <section className={styles.cards} aria-label="Benefits">
          {cards.map((card) => (
            <article key={card.title} className={styles.card}>
              <span>{card.number}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </section>
        <section className={styles.intro}>
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>WHY I BUILT IT</p>
            <h2>
              My agents were waiting on Git.
              <br />
              Then my disk filled up.
            </h2>
          </div>
          <p>
            I run fleets of coding agents, each in its own checkout. Every task started by cloning repositories and
            submodules from scratch, so agents sat idle waiting on downloads. Then I started running out of disk space,
            because every checkout held another full copy of the same history. git-dedup fixed both: my agents start
            dramatically faster, and I got 24 GB of disk back.
          </p>
        </section>
        <section className={styles.callout}>
          <div>
            <p className={styles.kicker}>BUILT ON GIT</p>
            <h2>Dogfooded daily.</h2>
            <p>
              git-dedup uses Git's own alternates mechanism, so every checkout stays an ordinary repository with its
              real origin. We have spent a lot of time running it across our own agent fleets and repositories to make
              it robust and fast. Worktrees, submodules, forks, and existing checkouts all just work.
            </p>
            <Link to="/docs">Read the getting started guide →</Link>
          </div>
          <figure
            className={styles.diagram}
            aria-label="One remote fetched into a shared object pool used by three clones"
          >
            <div className={styles.diagramHeader}>
              GIT OBJECT FLOW <span>● ● ●</span>
            </div>
            <div className={styles.remote}>
              <span className={styles.nodeIcon}>↗</span>
              <div>
                <small>REMOTE</small>
                <strong>github.com/you/project</strong>
              </div>
            </div>
            <div className={styles.connector}>↓</div>
            <div className={styles.mirror}>
              <span className={styles.nodeIcon}>◆</span>
              <div>
                <small>~/.git-dedup</small>
                <strong>one shared copy of history</strong>
              </div>
              <span className={styles.shared}>shared</span>
            </div>
            <div className={styles.branches}>
              <span>↙</span>
              <span>↓</span>
              <span>↘</span>
            </div>
            <div className={styles.clones}>
              <span>agent A</span>
              <span>agent B</span>
              <span>agent C</span>
            </div>
            <p>Every checkout borrows from the same store.</p>
          </figure>
        </section>
        <section className={styles.note}>
          <strong>Keep ~/.git-dedup.</strong>
          <span>
            Your checkouts read their history from the shared store. Deleting it breaks every repository using it.
          </span>
          <Link to="/docs/safety">Read about the store →</Link>
        </section>
      </main>
    </Layout>
  );
}

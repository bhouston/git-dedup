import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './index.module.css';

const cards = [
  {
    number: '01',
    title: 'One object pool',
    body: 'One bare Git repository collects objects from all registered remotes. Identical objects share storage.',
  },
  {
    number: '02',
    title: 'Normal working copies',
    body: 'Clones remain ordinary repositories with their real origin URL. They borrow objects through Git alternates.',
  },
  {
    number: '03',
    title: 'Git command passthrough',
    body: 'Commands outside the supported path run through Git. Your existing Git workflow stays available.',
  },
];

export default function Home() {
  return (
    <Layout
      title="Many coding agents, one copy of Git history"
      description="A Git wrapper whose clones, forks, and worktree submodules share one local object pool."
    >
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.copy}>
            <h1>
              Many coding agents.
              <br />
              <em>One copy of Git history.</em>
            </h1>
            <p className={styles.lead}>
              Agents and editors clone the same repositories for every task. git-dedup is a Git wrapper whose clones,
              forks, and worktree submodules share one local object pool, so each new checkout reuses the history
              already on disk.
            </p>
            <pre className={styles.example}>
              <code>{`# Populate the object pool in ~/.git-dedup.
git-dedup clone https://github.com/you/project.git project

# Another checkout borrows objects from the same pool.
git-dedup clone https://github.com/you/project.git project-review
cd project-review

# All normal Git commands work in the checkout.
git status
git diff
git log --oneline`}</code>
            </pre>
            <p className={styles.performance}>
              In one typical local setup spanning 117 checkouts (94 distinct Git object databases, with linked worktrees
              counted once), git-dedup uses 11.1 GB for Git objects versus 35.5 GB without sharing, saving about 24.4 GB
              (70%). Checkout is also 6x faster for large repos, dropping from over 1 minute to 10 seconds.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} to="/docs">
                Get started <span aria-hidden="true">↗</span>
              </Link>
              <Link className={styles.secondary} to="/docs/how-it-works">
                See how it works <span aria-hidden="true">→</span>
              </Link>
            </div>
            <p className={styles.platform}>TypeScript · Node.js 22+ · macOS and Linux</p>
          </div>
        </div>
      </header>
      <main>
        <section className={styles.intro}>
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>THE IDEA</p>
            <h2>
              More worktrees and clones.
              <br />
              Less duplicate data.
            </h2>
          </div>
          <p>
            Development often means several copies of the same repository: separate tasks, agents, experiments, and
            worktrees. git-dedup <strong>automatically</strong> puts reusable Git objects in a local store and keeps the
            consumer repositories connected to it through Git alternates. It manages remote updates and reference paths
            for you.
          </p>
        </section>
        <section className={styles.cards} aria-label="Design principles">
          {cards.map((card) => (
            <article key={card.number} className={styles.card}>
              <span>{card.number}</span>
              <h3>{card.title}</h3>
              <p>{card.body}</p>
            </article>
          ))}
        </section>
        <section className={styles.callout}>
          <div>
            <p className={styles.kicker}>BUILT ON GIT</p>
            <h2>Start with one clone.</h2>
            <p>
              Try git-dedup on a remote repository, inspect the resulting origin, and compare the object files in the
              clone and store.
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
                <small>LOCAL STORE</small>
                <strong>one object pool</strong>
              </div>
              <span className={styles.shared}>shared</span>
            </div>
            <div className={styles.branches}>
              <span>↙</span>
              <span>↓</span>
              <span>↘</span>
            </div>
            <div className={styles.clones}>
              <span>clone A</span>
              <span>clone B</span>
              <span>clone C</span>
            </div>
            <p>Working copies with shared object storage.</p>
          </figure>
        </section>
        <section className={styles.note}>
          <strong>Keep the pool available.</strong>
          <span>Linked checkouts borrow Git objects from the pool. Removing it can make their history unreadable.</span>
          <Link to="/docs/safety">Read about the store dependency →</Link>
        </section>
      </main>
    </Layout>
  );
}

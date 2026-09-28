import React from 'react';
import Layout from '@theme/Layout';
import Link from '@docusaurus/Link';
import styles from './index.module.css';

const cards = [
  {
    number: '01',
    title: 'One mirror per remote',
    body: 'A local bare mirror collects the remote’s Git objects so repeated clones can draw from one store.',
  },
  {
    number: '02',
    title: 'Normal working copies',
    body: 'Clones remain ordinary repositories with their real origin URL. They do not depend on Git alternates.',
  },
  {
    number: '03',
    title: 'A safe way back',
    body: 'Commands outside the supported path run through Git. Your existing Git workflow stays available.',
  },
];

export default function Home() {
  return (
    <Layout
      title="Git storage for agentic workflows"
      description="Optimized for short-lived repositories in agentic workflows. Automatically reuse Git objects across repeated checkouts and worktrees with submodules."
    >
      <header className={styles.hero}>
        <div className={styles.heroInner}>
          <div className={styles.copy}>
            <p className={styles.kicker}>
              <span className={styles.dot} /> THE GIT STORAGE WRAPPER
            </p>
            <h1>
              Clone freely.
              <br />
              <em>Store once.</em>
            </h1>
            <p className={styles.lead}>
              Optimized for short-lived repositories in agentic workflows. <strong>Automatically</strong> reuse Git
              objects across repeated checkouts and worktrees with submodules, with fewer downloads and less duplicate
              object storage.
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
          <figure
            className={styles.diagram}
            aria-label="One remote mirrored into a local store and shared by three clones"
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
                <strong>one bare mirror</strong>
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
            <p>Independent checkouts. Shared object storage.</p>
          </figure>
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
            worktrees. gitx <strong>automatically</strong> puts reusable Git objects in a local store and keeps the
            consumer repositories self-contained. It manages mirror creation, updates, and reuse for you, removing the
            bookkeeping of maintaining mirrors and passing reference paths to each clone.
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
              Try gitx on a remote repository, inspect the resulting origin, and compare the object files in the clone
              and store.
            </p>
            <Link to="/docs">Read the getting started guide →</Link>
          </div>
          <pre>
            <code>{`gitx clone https://github.com/you/project.git\ncd project\ngit remote -v`}</code>
          </pre>
        </section>
        <section className={styles.note}>
          <strong>Designed to be removable.</strong>
          <span>
            Clones use their own Git object directories. Deleting the store does not remove objects already present in a
            clone.
          </span>
          <Link to="/docs/safety">Read the safety model →</Link>
        </section>
      </main>
    </Layout>
  );
}

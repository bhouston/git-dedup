module.exports = {
  title: 'gitx',
  tagline: 'Optimized for short-lived repositories in agentic workflows.',
  favicon: 'img/gitx-mark.svg',
  url: process.env.SITE_URL ?? 'https://bhouston.github.io',
  baseUrl: process.env.BASE_URL ?? '/gix/',
  organizationName: 'bhouston',
  projectName: 'gix',
  onBrokenLinks: 'throw',
  markdown: { format: 'md' },
  presets: [
    [
      'classic',
      {
        docs: { routeBasePath: 'docs', sidebarPath: './sidebars.js' },
        blog: false,
        theme: { customCss: './src/css/custom.css' },
      },
    ],
  ],
  themeConfig: {
    navbar: {
      title: 'gitx',
      logo: { alt: 'gitx', src: 'img/gitx-mark.svg' },
      items: [
        { to: '/docs', label: 'Get started', position: 'left' },
        { to: '/docs/cli', label: 'CLI', position: 'left' },
        { to: '/docs/how-it-works', label: 'How it works', position: 'left' },
        { to: '/docs/roadmap', label: 'Roadmap', position: 'left' },
        { href: 'https://github.com/bhouston/gix', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'gitx',
          items: [
            { label: 'Documentation', to: '/docs' },
            { label: 'Safety', to: '/docs/safety' },
          ],
        },
        {
          title: 'Project',
          items: [
            { label: 'Source', href: 'https://github.com/bhouston/gix' },
            { label: 'Development', to: '/docs/development' },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} gitx contributors`,
    },
  },
};

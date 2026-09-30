const clidocPlugin = require('@clidoc/docusaurus');

module.exports = {
  title: 'git-dedup',
  tagline: 'Many coding agents, one copy of Git history.',
  favicon: 'img/git-dedup-mark.svg',
  url: process.env.SITE_URL ?? 'https://git-dedup.ben3d.ca',
  baseUrl: process.env.BASE_URL ?? '/',
  organizationName: 'bhouston',
  projectName: 'git-dedup',
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
  plugins: [[clidocPlugin, { input: '.generated/git-dedup.json', outputDir: 'docs/cli', basePath: '/cli' }]],
  themeConfig: {
    navbar: {
      title: 'git-dedup',
      logo: { alt: 'git-dedup', src: 'img/git-dedup-mark.svg' },
      items: [
        { to: '/docs', label: 'Get started', position: 'left' },
        { to: '/docs/cli', label: 'CLI', position: 'left' },
        { to: '/docs/how-it-works', label: 'How it works', position: 'left' },
        { href: 'https://github.com/bhouston/git-dedup', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      copyright: `Copyright © ${new Date().getFullYear()} git-dedup · MIT · Created with love ❤️ by <a href="https://ben3d.ca">Ben Houston</a> · Sponsored by <a href="https://landofassets.com">Land of Assets</a>`,
    },
  },
};

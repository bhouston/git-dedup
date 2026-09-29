const clidocPlugin = require('@clidoc/docusaurus');

module.exports = {
  title: 'gitx',
  tagline: 'Optimized for short-lived repositories in agentic workflows.',
  favicon: 'img/gitx-mark.svg',
  url: process.env.SITE_URL ?? 'https://gitx.ben3d.ca',
  baseUrl: process.env.BASE_URL ?? '/',
  organizationName: 'bhouston',
  projectName: 'gitx',
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
  plugins: [[clidocPlugin, { input: '.generated/gitx.json', outputDir: 'docs/cli', basePath: '/cli' }]],
  themeConfig: {
    navbar: {
      title: 'gitx',
      logo: { alt: 'gitx', src: 'img/gitx-mark.svg' },
      items: [
        { to: '/docs', label: 'Get started', position: 'left' },
        { to: '/docs/cli', label: 'CLI', position: 'left' },
        { to: '/docs/how-it-works', label: 'How it works', position: 'left' },
        { href: 'https://github.com/bhouston/gitx', label: 'GitHub', position: 'right' },
      ],
    },
    footer: {
      style: 'dark',
      copyright: `Copyright © ${new Date().getFullYear()} gitx · MIT · Created with love ❤️ by <a href="https://ben3d.ca">Ben Houston</a> · Sponsored by <a href="https://landofassets.com">Land of Assets</a>`,
    },
  },
};

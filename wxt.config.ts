import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: ({ browser }) => ({
    name: 'Stream2JD',
    description: 'Detecta streams, organiza qualidades e intercepta downloads para o JDownloader 2.',
    permissions: ['webRequest', 'tabs', 'storage', 'cookies', 'nativeMessaging', 'downloads'],
    host_permissions: ['<all_urls>', 'http://127.0.0.1:17442/*'],
    action: {
      default_title: 'Stream2JD',
    },
    web_accessible_resources: [
      {
        resources: ['youtube-main-world.js'],
        matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*'],
      },
      {
        resources: ['stream2jd-intercept.js'],
        matches: ['<all_urls>'],
      },
    ],
    key:
      browser === 'chrome'
        ? 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqnj+PznGjlHf9+497Zi6hui/EjP79Xi+opdHzkZc2eqnbbSjyKQwgjGeJsxkNlqgFSv8tkptu0Sf1epKxEodxz9bJMOIEFjtMoDhyUQApRBnBOtxv3/xOq2deC25Utc7GtQF9kh7ixsxjoPzIcOsj/lfhnFi1UdMoFhfTjGbI+6KWl7a2/NcGXi953pNll2LF6QDvZY6U5VziqrD5stS8vymH/Q0mrsy3PMVGhhLtIJ6zzLuHVPUJuz6wCDne4VDHHa85AkyPkamP9rrp6vOT8GW1BafYQlqQJlYsLMvKowdSTsEG7ny190CYxe7VdWr+8cZbWXXxbRurEEy3IxRwwIDAQAB'
        : undefined,
    browser_specific_settings:
      browser === 'firefox'
        ? {
            gecko: {
              id: '{c0ffce9c-d7b2-4ca9-8a4c-ddfceec9f259}',
              strict_min_version: '140.0',
              data_collection_permissions: {
                required: ['authenticationInfo', 'browsingActivity', 'websiteContent'],
              },
            },
            gecko_android: {
              strict_min_version: '142.0',
            },
          }
        : undefined,
  }),
});

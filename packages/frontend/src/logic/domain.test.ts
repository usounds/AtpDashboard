import assert from 'node:assert/strict';
import test from 'node:test';
import { getPublicSuffix, getRegistrantNsid, getWebDomainFromNsid, getFaviconUrl } from './domain.ts';

test('resolves apex web domains from reverse DNS NSIDs', () => {
  assert.equal(getWebDomainFromNsid('app.bsky.feed.post'), 'bsky.app');
  assert.equal(getWebDomainFromNsid('com.whtwnd.blog.entry'), 'whtwnd.com');
  assert.equal(getWebDomainFromNsid('blue.zio.atfile.upload'), 'zio.blue');
  assert.equal(getWebDomainFromNsid('fyi.unravel.frontpage.post'), 'unravel.fyi');
  assert.equal(getWebDomainFromNsid('uk.skyblur.post'), 'skyblur.uk');
  assert.equal(getWebDomainFromNsid('social.psky.chat.message'), 'psky.social');
  assert.equal(getWebDomainFromNsid('tools.ozone.moderation.defs'), 'ozone.tools');
});

test('handles multi-label public suffixes like co.uk', () => {
  assert.equal(getPublicSuffix('example.co.uk'), 'co.uk');
  assert.equal(getRegistrantNsid('uk.co.example.app.record'), 'uk.co.example');
  assert.equal(getWebDomainFromNsid('uk.co.example.app.record'), 'example.co.uk');
});

test('generates valid Google Favicon URLs', () => {
  assert.equal(
    getFaviconUrl('whtwnd.com', 32),
    'https://www.google.com/s2/favicons?domain=whtwnd.com&sz=32'
  );
});

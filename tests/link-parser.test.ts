import { describe, expect, it } from 'bun:test';
import {
  extractTgPostLinks,
  parseTgPostLink,
  selectFirstTgLink,
  selectFirstTgPostLink,
} from '../src/telegram/link-parser';

describe('link-parser', () => {
  it('parses a canonical post link', () => {
    expect(parseTgPostLink('https://t.me/flexinout/25')).toEqual({
      kind: 'post',
      url: 'https://t.me/flexinout/25',
      username: 'flexinout',
      messageId: 25,
    });
  });

  it('parses host variants, http and query strings', () => {
    expect(parseTgPostLink('http://telegram.me/some_channel/15?single')?.messageId).toBe(15);
    expect(parseTgPostLink('https://www.telegram.dog/abcde/1')?.username).toBe('abcde');
  });

  it('rejects non-post links', () => {
    for (const link of [
      'https://t.me/durov',
      'https://t.me/+AbCdEf',
      'https://t.me/joinchat/AbCdEf',
      'https://t.me/c/123456/789',
      'https://example.com/flexinout/25',
      'https://t.me/s/newsnarika/5',
      'https://t.me/newsnarika/5abc',
    ]) {
      expect(parseTgPostLink(link)).toBeNull();
    }
  });

  it('extracts and dedupes links from html preserving order', () => {
    const html = `
      <a href="https://t.me/newsnarika/7">https://t.me/newsnarika/7</a>
      <a href="https://t.me/newsnarika">channel</a>
      <div data-plain="https://t.me/newsnarika/7"></div>
      <a href="https://t.me/flexinout/25">second</a>
    `;

    const links = extractTgPostLinks(html);
    expect(links.map((link) => link.url)).toEqual([
      'https://t.me/newsnarika/7',
      'https://t.me/flexinout/25',
    ]);
  });

  it('finds links inside hidden content blocks', () => {
    const html = `<blockquote><a href="https://t.me/xenophe_lolz/5">https://t.me/xenophe_lolz/5</a></blockquote>`;
    expect(selectFirstTgPostLink(html)?.url).toBe('https://t.me/xenophe_lolz/5');
  });

  it('returns null when there is no link', () => {
    expect(selectFirstTgPostLink('<div>no links here</div>')).toBeNull();
    expect(extractTgPostLinks('[MEDIA]')).toEqual([]);
  });

  it('parses bare channel links and prefers a specific post', () => {
    expect(selectFirstTgLink('<a href="https://t.me/flexinout">x</a>')).toEqual({
      kind: 'channel',
      url: 'https://t.me/flexinout',
      username: 'flexinout',
    });

    const html =
      '<a href="https://t.me/somechannel">c</a> <a href="https://t.me/somechannel/5">p</a>';
    expect(selectFirstTgLink(html)).toMatchObject({ kind: 'post', messageId: 5 });
  });

  it('rejects invite/private/web-preview links in channel mode', () => {
    for (const link of [
      'https://t.me/+AbCdEf',
      'https://t.me/joinchat/AbCdEf',
      'https://t.me/c/123456/789',
      'https://t.me/s/newsnarika/5',
    ]) {
      expect(selectFirstTgLink(link)).toBeNull();
    }
  });
});

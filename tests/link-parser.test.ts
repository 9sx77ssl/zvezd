import { describe, expect, it } from 'bun:test';
import {
  channelOfLink,
  distinctChannelCount,
  extractTgLinks,
  extractTgPostLinks,
  parseTgChannelLink,
  parseTgPostLink,
  selectFirstTgLink,
  selectFirstTgPostLink,
  selectLinkCandidates,
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

  it('extracts the link from a revealed "hidden content" (bbCodeHide) block', () => {
    // Real shape: the link is inside the hide block, next to lolz.team profile
    // links that must not be picked up.
    const html =
      '<div class="bbCodeBlock bbCodeQuote bbCodeHide"><aside>' +
      '<div class="attribution type">Скрытый контент для <a href="https://lolz.team/gay1234/" class="username">yolo</a>.</div>' +
      '<blockquote class="quoteContainer hideContainer"><div class="quote">' +
      '<a href="https://lolz.team/members/9252369/" class="username mention">yolo</a>,  ' +
      '<a href="https://t.me/baoldgold/4" rel="nofollow" class="externalLink" target="_blank">https://t.me/baoldgold/4</a>' +
      '</div><div class="quoteExpand">Нажмите, чтобы раскрыть...</div></blockquote>' +
      '</aside></div>';

    expect(selectFirstTgLink(html)).toEqual({
      kind: 'post',
      url: 'https://t.me/baoldgold/4',
      username: 'baoldgold',
      messageId: 4,
    });
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

  it('parses a single bare channel link', () => {
    expect(parseTgChannelLink('https://t.me/flexinout')).toEqual({
      kind: 'channel',
      url: 'https://t.me/flexinout',
      username: 'flexinout',
    });
    expect(parseTgChannelLink('telegram.dog/flexinout/')?.username).toBe('flexinout');
    expect(parseTgChannelLink('https://t.me/flexinout/25')).toBeNull();
    expect(parseTgChannelLink('https://t.me/+AbCdEf')).toBeNull();
  });

  it('derives the channel username from any stored link', () => {
    expect(channelOfLink('https://t.me/flexinout/25')).toBe('flexinout');
    expect(channelOfLink('https://t.me/flexinout')).toBe('flexinout');
    expect(channelOfLink('https://t.me/+AbCdEf')).toBeNull();
    expect(channelOfLink('not a link')).toBeNull();
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

  it('orders star candidates by appearance, ignoring non-TG hosts', () => {
    const html =
      '<a href="https://youtube.com/watch?v=x">yt</a> ' +
      '<a href="https://t.me/paid">paid</a> ' +
      '<a href="https://t.me/good/7">good</a> ' +
      '<a href="https://t.me/empty">empty</a>';

    expect(selectLinkCandidates(html).map((link) => link.url)).toEqual([
      'https://t.me/paid',
      'https://t.me/good/7',
      'https://t.me/empty',
    ]);
  });

  it('drops a bare channel link when the same channel has a post link', () => {
    const html =
      '<a href="https://t.me/fooo">c</a> <a href="https://t.me/fooo/5">p</a> <a href="https://t.me/barr">b</a>';

    expect(selectLinkCandidates(html).map((link) => link.url)).toEqual([
      'https://t.me/fooo/5',
      'https://t.me/barr',
    ]);
  });

  it('counts distinct channels for the multi-link note', () => {
    const html =
      '<a href="https://t.me/fooo">c</a> <a href="https://t.me/fooo/5">p</a> <a href="https://t.me/barr">b</a>';
    expect(distinctChannelCount(selectLinkCandidates(html))).toBe(2);
    expect(distinctChannelCount(selectLinkCandidates('<a href="https://t.me/fooo/5">p</a>'))).toBe(
      1,
    );
  });

  it('ignores links in a "Переслано из" (lztTgPost-forwarded) block', () => {
    const html =
      '<div class="lztTgPost TelegramUnfurl"><div class="lztTgPost-header">' +
      '<a href="https://t.me/newsnarika" class="lztTgPost-authorName">иᴄᴛᴏᴩия</a>' +
      '<a href="https://t.me/newsnarika/169" class="link lztTgPost-source">https://t.me/newsnarika/169</a>' +
      '</div>' +
      '<div class="lztTgPost-forwarded"><i class="fal fa-share"></i>Переслано из ' +
      '<a href="https://t.me/loon_79" rel="nofollow">crazy lady</a></div></div>';

    expect(extractTgLinks(html).map((link) => link.url)).toEqual([
      'https://t.me/newsnarika',
      'https://t.me/newsnarika/169',
    ]);
    expect(selectLinkCandidates(html).map((link) => link.url)).toEqual([
      'https://t.me/newsnarika/169',
    ]);
    expect(distinctChannelCount(selectLinkCandidates(html))).toBe(1);
  });
});

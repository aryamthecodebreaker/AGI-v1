import { describe, expect, it } from 'vitest';
import {
  decodeHtml,
  isBlockedHostname,
  isPrivateAddress,
  parseBingRss,
  parseDuckDuckGoHtml,
  shouldSearchWeb,
} from '../src/llm/webSearch.js';

describe('provider-independent web search parsing', () => {
  it('parses DuckDuckGo redirects, titles, and snippets', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fabout%2Fprevious-releases">Node.js &amp; releases</a>
        <a class="result__snippet">Node.js release status and supported versions.</a>
      </div>
      <div class="result">
        <a class="result__a" href="https://example.org/second">Second result</a>
        <div class="result__snippet">Another snippet.</div>
      </div>
    `;

    expect(parseDuckDuckGoHtml(html, 2)).toEqual([
      {
        title: 'Node.js & releases',
        url: 'https://nodejs.org/en/about/previous-releases',
        snippet: 'Node.js release status and supported versions.',
      },
      {
        title: 'Second result',
        url: 'https://example.org/second',
        snippet: 'Another snippet.',
      },
    ]);
  });

  it('parses Bing RSS as a fallback and removes duplicates', () => {
    const xml = `
      <rss><channel>
        <item><title>Node.js releases</title><link>https://nodejs.org/en/about/previous-releases</link><description>Release table</description></item>
        <item><title>Duplicate</title><link>https://nodejs.org/en/about/previous-releases</link><description>Duplicate</description></item>
      </channel></rss>
    `;

    expect(parseBingRss(xml, 3)).toEqual([{
      title: 'Node.js releases',
      url: 'https://nodejs.org/en/about/previous-releases',
      snippet: 'Release table',
    }]);
  });

  it('detects search intent without searching every ordinary chat turn', () => {
    expect(shouldSearchWeb('search for amy-tutor.vercel.app')).toBe(true);
    expect(shouldSearchWeb('What is the latest Node.js release?')).toBe(true);
    expect(shouldSearchWeb('https://example.com/docs')).toBe(true);
    expect(shouldSearchWeb('Tell me about Node.js')).toBe(false);
    expect(shouldSearchWeb('How are you?')).toBe(false);
    expect(shouldSearchWeb('Remember that my favorite color is blue.')).toBe(false);
  });

  it('blocks local hostnames and private network addresses', () => {
    expect(isBlockedHostname('localhost')).toBe(true);
    expect(isBlockedHostname('127.0.0.1')).toBe(true);
    expect(isBlockedHostname('service.internal')).toBe(true);
    expect(isBlockedHostname('example.com')).toBe(false);
    expect(isPrivateAddress('10.0.0.1')).toBe(true);
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('decodes common named and numeric HTML entities', () => {
    expect(decodeHtml('A &amp; B &#x2014; &#169;')).toBe('A & B — ©');
  });
});

import { describe, expect, it } from 'vitest';
import { parseMessageSegments } from '../public/messageLinks.js';

describe('message link parsing', () => {
  it('removes angle brackets from autolink labels and destinations', () => {
    expect(parseMessageSegments('Source: <https://amy-tutor.vercel.app/>')).toEqual([
      { text: 'Source: ' },
      { text: 'https://amy-tutor.vercel.app/', url: 'https://amy-tutor.vercel.app/' },
    ]);
  });

  it('keeps markdown and plain HTTP links clickable', () => {
    expect(parseMessageSegments('[Amy](https://amy-tutor.vercel.app/) or https://example.com')).toEqual([
      { text: 'Amy', url: 'https://amy-tutor.vercel.app/' },
      { text: ' or ' },
      { text: 'https://example.com', url: 'https://example.com/' },
    ]);
  });
});

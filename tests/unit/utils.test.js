import crypto from 'crypto';
import { csvCell, csvRow } from '../../src/utils/csv.js';
import { parseSort, pageParams } from '../../src/utils/http.js';
import { verifySignature } from '../../src/services/paystack.client.js';
import { escapeHtml } from '../../src/services/notification.service.js';
import env from '../../src/config/env.js';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvRow(['a,b', 'say "hi"', 'x\ny', null, 3])).toBe('"a,b","say ""hi""","x\ny",,3');
  });
  it('neutralises formula prefixes', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+234')).toBe("'+234");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('plain')).toBe('plain');
  });
  it('formats dates as ISO', () => {
    expect(csvCell(new Date('2026-10-08T00:00:00Z'))).toBe('2026-10-08T00:00:00.000Z');
  });
});

describe('http helpers', () => {
  it('parseSort keeps only allowed fields', () => {
    expect(parseSort('-startAt,title,password', ['startAt', 'title'], { x: 1 })).toEqual({ startAt: -1, title: 1 });
    expect(parseSort('password', ['startAt'], { startAt: 1 })).toEqual({ startAt: 1 });
    expect(parseSort(undefined, ['startAt'], { startAt: 1 })).toEqual({ startAt: 1 });
  });
  it('pageParams clamps page and limit', () => {
    expect(pageParams({ page: '3', limit: '10' })).toEqual({ page: 3, limit: 10, skip: 20 });
    expect(pageParams({ page: '-1', limit: '999' })).toEqual({ page: 1, limit: 50, skip: 0 });
    expect(pageParams({})).toEqual({ page: 1, limit: 20, skip: 0 });
  });
});

describe('paystack signature', () => {
  const body = Buffer.from('{"event":"charge.success"}');
  const sig = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(body).digest('hex');
  it('accepts the right HMAC and rejects anything else', () => {
    expect(verifySignature(body, sig)).toBe(true);
    expect(verifySignature(body, sig.replace(/.$/, '0'))).toBe(sig.endsWith('0'));
    expect(verifySignature(body, 'short')).toBe(false);
    expect(verifySignature(body, undefined)).toBe(false);
    expect(verifySignature(Buffer.from('{"tampered":1}'), sig)).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes markup in user-provided names', () => {
    expect(escapeHtml('<script>"x"&\'y\'')).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;');
  });
});

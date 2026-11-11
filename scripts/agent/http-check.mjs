#!/usr/bin/env node
/**
 * Diagnose: roept URL's aan vanaf de pc zelf (zoals de gsm of de browser dat doet)
 * en toont status, duur en redirect. Leest niets geheims; volgt geen redirects.
 *   node scripts/agent/http-check.mjs <url> [<url> ...]
 * Elke aanvraag heeft een time-out van 20 s.
 */
const urls = process.argv.slice(2);
if (urls.length === 0) throw new Error('Gebruik: node scripts/agent/http-check.mjs <url> [...]');
for (const url of urls) {
  const started = Date.now();
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    console.log(JSON.stringify({
      url: url.length > 120 ? `${url.slice(0, 117)}...` : url,
      status: response.status,
      ms: Date.now() - started,
      location: response.headers.get('location'),
      contentType: response.headers.get('content-type'),
      bytes: text.length,
      snippet: text.replace(/\s+/g, ' ').slice(0, 160),
    }));
  } catch (error) {
    console.log(JSON.stringify({ url: url.slice(0, 120), error: error.name, message: error.message, ms: Date.now() - started }));
  }
}

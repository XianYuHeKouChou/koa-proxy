import http from 'node:http';
import https from 'node:https';
import Koa from 'koa';

const app = new Koa();
const port = process.env.PORT || 7891;
const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function getTargetUrl(ctx) {
  const proxyHost = ctx.get('proxyHost');

  if (!proxyHost) {
    throw new Error('Missing proxyHost request header');
  }

  const target = new URL(proxyHost);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('proxyHost must use http or https');
  }

  if (ctx.querystring) {
    target.search = target.search
      ? `${target.search.slice(1)}&${ctx.querystring}`
      : ctx.querystring;
  }

  return target;
}

function getForwardHeaders(ctx, target) {
  const headers = { ...ctx.request.headers };
  headers.host = target.host;
  return headers;
}

function proxyRequest(ctx, target) {
  const transport = target.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      target,
      {
        method: ctx.method,
        headers: getForwardHeaders(ctx, target),
      },
      (response) => {
        const chunks = [];

        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            statusCode: response.statusCode || 502,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    request.on('error', reject);
    ctx.req.on('aborted', () => request.destroy());

    // The raw request stream keeps every content-type and body format intact.
    ctx.req.pipe(request);
  });
}

function setResponseHeaders(ctx, headers) {
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined && !hopByHopHeaders.has(name.toLowerCase())) {
      ctx.set(name, value);
    }
  }
}

app.use(async (ctx) => {
  const origin = ctx.get('origin');
  if (origin) {
    ctx.set('Access-Control-Allow-Origin', origin);
    ctx.set('Access-Control-Allow-Credentials', 'true');
    ctx.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
    ctx.set(
      'Access-Control-Allow-Headers',
      ctx.get('access-control-request-headers') || 'proxyHost, Content-Type',
    );
    ctx.set('Vary', 'Origin');
  }

  if (ctx.method === 'OPTIONS') {
    ctx.status = 204;
    return;
  }

  let target;
  try {
    target = getTargetUrl(ctx);
  } catch (error) {
    ctx.status = 400;
    ctx.body = { error: error.message };
    return;
  }

  try {
    const response = await proxyRequest(ctx, target);
    ctx.status = response.statusCode;
    setResponseHeaders(ctx, response.headers);
    ctx.body = response.body;
  } catch (error) {
    ctx.status = 502;
    ctx.body = { error: `Proxy request failed: ${error.message}` };
  }
});

app.listen(port, () => {
  console.log(`Koa proxy is running at http://localhost:${port}`);
});

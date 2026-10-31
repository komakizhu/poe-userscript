'use strict';

// Local-only browser fixture. No dependencies, Poe requests or real messages.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const routes = new Map([
    ['/', ['scroll-lock.browser.html', 'text/html; charset=utf-8']],
    ['/Poe_Effort_Points.user.js', ['../Poe_Effort_Points.user.js', 'text/javascript; charset=utf-8']]
]);
const server = http.createServer((request, response) => {
    const route = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!route) { response.writeHead(404); response.end('Not found'); return; }
    response.writeHead(200, { 'Content-Type': route[1], 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(__dirname, route[0])).pipe(response);
});
server.listen(Number(process.env.POE_SCROLL_TEST_PORT || 8769), '127.0.0.1', () => {
    console.log(`Scroll fixture: http://127.0.0.1:${server.address().port}/`);
});

// Copyright IBM Corp. 2019. All Rights Reserved.
// Node module: @loopback/http-caching-proxy
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

import {expect} from '@loopback/testlab';
import delay from 'delay';
import * as got from 'got';
import * as http from 'http';
import {AddressInfo} from 'net';
import pEvent from 'p-event';
import * as path from 'path';
import * as rimrafCb from 'rimraf';
import * as util from 'util';
import {HttpCachingProxy, ProxyOptions} from '../../http-caching-proxy';
import HttpProxyAgent = require('http-proxy-agent');

const CACHE_DIR = path.join(__dirname, '.cache');

// tslint:disable:await-promise
const rimraf = util.promisify(rimrafCb);

// tslint:disable-next-line:no-any
const makeRequest = (got as any).extend({
  followRedirect: false,
  retry: 0,
}) as typeof got;

describe('HttpCachingProxy', () => {
  let stubServerUrl: string;
  before(givenStubServer);
  after(stopStubServer);

  let proxy: HttpCachingProxy;
  after(stopProxy);

  beforeEach('clean cache dir', async () => await rimraf(CACHE_DIR));

  it('provides "url" property when running', async () => {
    await givenRunningProxy();
    expect(proxy.url).to.match(/^http:\/\/127.0.0.1:\d+$/);
  });

  it('provides invalid "url" property when not running', async () => {
    proxy = new HttpCachingProxy({cachePath: CACHE_DIR});
    expect(proxy.url).to.match(/not-running/);
  });

  it('proxies HTTP requests', async function() {
    // Increase the timeout to accommodate slow network connections
    // tslint:disable-next-line:no-invalid-this
    this.timeout(30000);

    await givenRunningProxy();
    const result = await makeRequest({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: proxy.port,
      path: 'http://example.com/',
    });
    expect(result.statusCode).to.equal(200);
    expect(result.body).to.containEql('example');
  });

  it('proxies HTTPs requests (no tunneling)', async function() {
    // Increase the timeout to accommodate slow network connections
    // tslint:disable-next-line:no-invalid-this
    this.timeout(30000);

    await givenRunningProxy();
    const result = await makeRequest('https://example.com', {
      agent: Object.assign(new HttpProxyAgent(proxy.url), {secureProxy: false}),
    });

    expect(result.statusCode).to.equal(200);
    expect(result.body).to.containEql('example');
  });

  it('rejects CONNECT requests (HTTPS tunneling)', async () => {
    await givenRunningProxy();
    const resultPromise = makeRequest('https://example.com', {
      agent: Object.assign(new HttpProxyAgent(proxy.url), {secureProxy: true}),
    });

    await expect(resultPromise).to.be.rejectedWith(
      /tunneling socket.*statusCode=501/,
    );
  });

  it('forwards request/response headers', async () => {
    await givenRunningProxy();
    givenServerDumpsRequests();

    const result = await makeRequest(stubServerUrl, {
      json: true,
      headers: {'x-client': 'test'},
      agent: new HttpProxyAgent(proxy.url),
    });

    expect(result.headers).to.containEql({
      'x-server': 'dumping-server',
    });
    expect(result.body.headers).to.containDeep({
      'x-client': 'test',
    });
  });

  it('forwards request body', async () => {
    await givenRunningProxy();
    stubServerHandler = (req, res) => req.pipe(res);

    const result = await makeRequest.post(stubServerUrl, {
      body: 'a text body',
      agent: new HttpProxyAgent(proxy.url),
    });

    expect(result).to.equal('a text body');
  });

  it('caches responses', async () => {
    await givenRunningProxy();
    let counter = 1;
    stubServerHandler = function(req, res) {
      res.writeHead(201, {'x-counter': counter++});
      res.end(JSON.stringify({counter: counter++}));
    };

    const opts = {
      uri: stubServerUrl,
      json: true,
      agent: new HttpProxyAgent(proxy.url),
    };

    const result1 = await makeRequest(opts);
    const result2 = await makeRequest(opts);

    expect(result1.statusCode).equal(201);

    expect(result1.statusCode).equal(result2.statusCode);
    expect(result1.body).deepEqual(result2.body);
    expect(result1.headers).deepEqual(result2.headers);
  });

  it('refreshes expired cache entries', async () => {
    await givenRunningProxy({ttl: 1});

    let counter = 1;
    stubServerHandler = (req, res) => res.end(String(counter++));

    const opts = {
      uri: stubServerUrl,
      agent: new HttpProxyAgent(proxy.url),
    };

    const result1 = await makeRequest(opts);
    await delay(10);
    const result2 = await makeRequest(opts);

    expect(result1).to.equal('1');
    expect(result2).to.equal('2');
  });

  it('handles the case where backend service is not running', async () => {
    await givenRunningProxy();
    proxy.logError = (request, error) => {}; // no-op

    await expect(
      makeRequest('http://127.0.0.1:1/', {
        agent: new HttpProxyAgent(proxy.url),
      }),
    ).to.be.rejectedWith({statusCode: 502});
  });

  async function givenRunningProxy(options?: Partial<ProxyOptions>) {
    proxy = new HttpCachingProxy(
      Object.assign({cachePath: CACHE_DIR}, options),
    );
    await proxy.start();
  }

  async function stopProxy() {
    if (!proxy) return;
    await proxy.stop();
  }

  let stubServer: http.Server | undefined,
    stubServerHandler:
      | ((request: http.IncomingMessage, response: http.ServerResponse) => void)
      | undefined;
  async function givenStubServer() {
    stubServerHandler = undefined;
    stubServer = http.createServer(function handleRequest(req, res) {
      if (stubServerHandler) {
        try {
          stubServerHandler(req, res);
        } catch (err) {
          res.end(500);
          process.nextTick(() => {
            throw err;
          });
        }
      } else {
        res.writeHead(501);
        res.end();
      }
    });
    stubServer.listen(0);
    await pEvent(stubServer, 'listening');
    const address = stubServer.address() as AddressInfo;
    stubServerUrl = `http://127.0.0.1:${address.port}`;
  }

  async function stopStubServer() {
    if (!stubServer) return;
    stubServer.close();
    await pEvent(stubServer, 'close');
    stubServer = undefined;
  }

  function givenServerDumpsRequests() {
    stubServerHandler = function dumpRequest(req, res) {
      res.writeHead(200, {
        'x-server': 'dumping-server',
      });
      res.write(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
        }),
      );
      res.end();
    };
  }
});

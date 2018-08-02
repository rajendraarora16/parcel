const Bundler = require('../src/Bundler');
const assert = require('assert');
const vm = require('vm');
const fs = require('../src/utils/fs');
const nodeFS = require('fs');
const path = require('path');
const WebSocket = require('ws');
const Module = require('module');

const promisify = require('../src/utils/promisify');
const rimraf = promisify(require('rimraf'));
const ncp = promisify(require('ncp'));

beforeEach(async function() {
  // Test run in a single process, creating and deleting the same file(s)
  // Windows needs a delay for the file handles to be released before deleting
  // is possible. Without a delay, rimraf fails on `beforeEach` for `/dist`
  if (process.platform === 'win32') {
    await sleep(50);
  }
  // Unix based systems also need a delay but only half as much as windows
  await sleep(50);
  await rimraf(path.join(__dirname, 'dist'));
});

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bundler(file, opts) {
  return new Bundler(
    file,
    Object.assign(
      {
        outDir: path.join(__dirname, 'dist'),
        watch: false,
        cache: false,
        killWorkers: false,
        hmr: false,
        logLevel: 0
      },
      opts
    )
  );
}

function bundle(file, opts) {
  return bundler(file, opts).bundle();
}

function prepareBrowserContext(bundle, globals) {
  // for testing dynamic imports
  const fakeElement = {
    remove() {}
  };

  const fakeDocument = {
    createElement(tag) {
      return {tag};
    },

    getElementsByTagName() {
      return [
        {
          appendChild(el) {
            setTimeout(function() {
              if (el.tag === 'script') {
                vm.runInContext(
                  nodeFS.readFileSync(path.join(__dirname, 'dist', el.src)),
                  ctx
                );
              }

              el.onload();
            }, 0);
          }
        }
      ];
    },

    getElementById() {
      return fakeElement;
    },

    body: {
      appendChild() {
        return null;
      }
    }
  };

  var exports = {};
  var ctx = Object.assign(
    {
      exports,
      module: {exports},
      document: fakeDocument,
      WebSocket,
      console,
      location: {hostname: 'localhost'},
      fetch(url) {
        return Promise.resolve({
          arrayBuffer() {
            return Promise.resolve(
              new Uint8Array(
                nodeFS.readFileSync(path.join(__dirname, 'dist', url))
              ).buffer
            );
          },
          text() {
            return Promise.resolve(
              nodeFS.readFileSync(path.join(__dirname, 'dist', url), 'utf8')
            );
          }
        });
      }
    },
    globals
  );

  ctx.window = ctx;
  return ctx;
}

function prepareNodeContext(bundle, globals) {
  var mod = new Module(bundle.name);
  mod.paths = [path.dirname(bundle.name) + '/node_modules'];

  var ctx = Object.assign(
    {
      module: mod,
      exports: module.exports,
      __filename: bundle.name,
      __dirname: path.dirname(bundle.name),
      require: function(path) {
        return mod.require(path);
      },
      console,
      process: process,
      setTimeout: setTimeout,
      setImmediate: setImmediate
    },
    globals
  );

  ctx.global = ctx;
  return ctx;
}

async function run(bundle, globals, opts = {}) {
  var ctx;
  switch (bundle.entryAsset.options.target) {
    case 'browser':
      ctx = prepareBrowserContext(bundle, globals);
      break;
    case 'node':
      ctx = prepareNodeContext(bundle, globals);
      break;
    case 'electron':
      ctx = Object.assign(
        prepareBrowserContext(bundle, globals),
        prepareNodeContext(bundle, globals)
      );
      break;
  }

  vm.createContext(ctx);
  vm.runInContext(await fs.readFile(bundle.name), ctx);

  if (opts.require !== false) {
    if (ctx.parcelRequire) {
      return ctx.parcelRequire(bundle.entryAsset.id);
    } else if (ctx.output) {
      return ctx.output;
    }
    if (ctx.module) {
      return ctx.module.exports;
    }
  }

  return ctx;
}

async function assertBundleTree(bundle, tree) {
  if (tree.name) {
    assert.equal(
      path.basename(bundle.name),
      tree.name,
      'bundle names mismatched'
    );
  }

  if (tree.type) {
    assert.equal(
      bundle.type.toLowerCase(),
      tree.type.toLowerCase(),
      'bundle types mismatched'
    );
  }

  if (tree.assets) {
    assert.deepEqual(
      Array.from(bundle.assets)
        .map(a => a.basename)
        .sort(),
      tree.assets.sort()
    );
  }

  let childBundles = Array.isArray(tree) ? tree : tree.childBundles;
  if (childBundles) {
    let children = Array.from(bundle.childBundles).sort(
      (a, b) =>
        Array.from(a.assets).sort()[0].basename <
        Array.from(b.assets).sort()[0].basename
          ? -1
          : 1
    );
    assert.equal(
      bundle.childBundles.size,
      childBundles.length,
      'expected number of child bundles mismatched'
    );
    await Promise.all(
      childBundles.map((b, i) => assertBundleTree(children[i], b))
    );
  }

  if (/js|css/.test(bundle.type)) {
    assert(await fs.exists(bundle.name), 'expected file does not exist');
  }
}

function nextBundle(b) {
  return new Promise(resolve => {
    b.once('bundled', resolve);
  });
}

function deferred() {
  let resolve, reject;
  let promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });

  promise.resolve = resolve;
  promise.reject = reject;

  return promise;
}

exports.sleep = sleep;
exports.bundler = bundler;
exports.bundle = bundle;
exports.run = run;
exports.assertBundleTree = assertBundleTree;
exports.nextBundle = nextBundle;
exports.deferred = deferred;
exports.rimraf = rimraf;
exports.ncp = ncp;

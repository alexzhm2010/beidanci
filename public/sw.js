/* v1.11.1 性能优化: Service Worker
 *
 * 策略:
 *   - 静态资源 (JS/CSS/HTML/字体/图片): Stale-While-Revalidate
 *     优先返回缓存 (瞬时响应), 后台异步更新缓存
 *   - Supabase API 请求: Network-Only (永远走网络, 保证数据实时)
 *
 * GitHub Pages 子路径部署:
 *   - sw.js 与 index.html 同目录, scope 为 ./
 *   - 缓存键使用 request.url 全路径, 避免不同子路径冲突
 *
 * 版本管理:
 *   - CACHE_NAME 含版本号, 新版上线时旧缓存自动清理
 *   - 跳过等待 + clients.claim 实现即时激活
 */

var CACHE_NAME = 'beidanci-v1.11.1';
var SUPABASE_HOST = 'gjtjivmxxelnousbqmok.supabase.co';

// 不缓存:Supabase API (数据需实时) + 第三方 OCR/翻译
function shouldNotCache(url) {
  return url.indexOf(SUPABASE_HOST) >= 0 ||
    url.indexOf('dictionaryapi.dev') >= 0 ||
    url.indexOf('mymemory.translated.net') >= 0 ||
    url.indexOf('cdn.jsdelivr.net') >= 0 ||  // Chart.js / Tesseract 等大库, 让浏览器自带缓存
    url.indexOf('esm.sh') >= 0 ||
    url.indexOf('unpkg.com') >= 0;
}

// 仅缓存 GET 请求, 跳过 chrome-extension:// 等
function shouldCache(request) {
  if (request.method !== 'GET') return false;
  var url = request.url;
  if (url.indexOf('http') !== 0) return false;  // 跳过 chrome-extension://, data: 等
  if (shouldNotCache(url)) return false;
  return true;
}

self.addEventListener('install', function (e) {
  // 跳过等待, 直接激活 (新版上线即时生效)
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(function () {
    var cacheNames = caches.keys();
    return Promise.all(cacheNames.then(function (names) {
      return Promise.all(names.map(function (name) {
        // 清理所有非当前版本缓存 (包括旧版本)
        if (name !== CACHE_NAME && name.indexOf('beidanci-') === 0) {
          return caches.delete(name);
        }
        return null;
      }));
    })).then(function () {
      // 立即接管所有 client
      return self.clients.claim();
    });
  }());
});

self.addEventListener('fetch', function (event) {
  var request = event.request;

  if (!shouldCache(request)) return;

  event.respondWith(
    (async function () {
      var cache = await caches.open(CACHE_NAME);
      var cachedResponse = await cache.match(request);

      // 后台更新缓存 (Stale-While-Revalidate)
      var fetchPromise = fetch(request).then(function (networkResponse) {
        // 仅缓存有效响应 (200)
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      }).catch(function (e) {
        // 离线时返回缓存 (即使有缓存也无)
        return cachedResponse || new Response('网络不可用', { status: 503 });
      });

      // 优先返回缓存 (瞬时响应), 缓存 miss 时等待网络
      return cachedResponse || fetchPromise;
    })()
  );
});

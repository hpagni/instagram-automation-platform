// IPRoyal API client. Lists ISP Dedicated proxies on the reseller account and
// returns them as `http://user:pass@ip:port` URLs ready to hand to a browser
// or HTTP client.
//
// Auth: IPRoyal's reseller API takes the API token as the `X-Access-Token`
// header. GET /v1/reseller/orders?product_id=9 lists ISP orders; each order's
// `proxy_data` carries ports.{http|https,socks5} and proxies[].{ip,username,
// password}. All IPs in a single order share one credential pair; the unit of
// assignment here is the individual IP, not the order.

const axios = require('axios');

const ISP_PRODUCT_ID = 9;
const API_BASE = 'https://apid.iproyal.com/v1';

function requireToken() {
  const t = process.env.IPROYAL_API_KEY;
  if (!t) throw new Error('IPROYAL_API_KEY env var is not set');
  return t;
}

async function listIspOrders() {
  const orders = [];
  let page = 1;
  while (true) {
    const r = await axios.get(`${API_BASE}/reseller/orders`, {
      headers: { 'X-Access-Token': requireToken() },
      params: { product_id: ISP_PRODUCT_ID, page, per_page: 50 },
      timeout: 30_000,
    });
    const batch = r.data?.data || [];
    orders.push(...batch);
    const meta = r.data?.meta || {};
    const lastPage = meta.last_page || meta.lastPage || 1;
    if (page >= lastPage || batch.length === 0) break;
    page++;
  }
  return orders;
}

// Flatten all active ISP orders into a list of individual proxy URLs, one per
// IP. Returns objects so callers can record which order each proxy came from
// when persisting the assignment.
async function listIspProxies() {
  const orders = await listIspOrders();
  const out = [];
  for (const order of orders) {
    if (order.status && order.status !== 'confirmed' && order.status !== 'active') continue;
    const ports = order.proxy_data?.ports || {};
    const httpPort = ports['http|https'] || ports.http || ports.https;
    if (!httpPort) continue;
    const proxies = order.proxy_data?.proxies || [];
    for (const p of proxies) {
      if (!p.ip || !p.username || !p.password) continue;
      const url = `http://${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@${p.ip}:${httpPort}`;
      out.push({
        url,
        host: p.ip,
        port: httpPort,
        username: p.username,
        password: p.password,
        orderId: order.id,
      });
    }
  }
  return out;
}

module.exports = { listIspProxies, listIspOrders };

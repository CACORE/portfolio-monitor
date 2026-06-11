// Telegram 警示由 GitHub Actions 的 check.py 負責（token 放 repo Secrets，不放前端）

// ===== 預設資料 =====
const DEFAULT_ASSETS = [
  { id: 'btc',  category: 'crypto', symbol: 'BTC',     name: '比特幣',    qty: 0.16217047, priceSource: 'binance',  currency: 'USD' },
  { id: 'bnb',  category: 'crypto', symbol: 'BNB',     name: '幣安幣',    qty: 3.29943355, priceSource: 'binance',  currency: 'USD' },
  { id: 'bgb',  category: 'crypto', symbol: 'BGB',     name: 'Bitget Token', qty: 340.1,  priceSource: 'bitget',   currency: 'USD' },
  { id: 'usd',  category: 'lending',symbol: 'USD',     name: '美元放貸',  qty: 3246.02,   priceSource: 'fixed',    currency: 'USD' },
  { id: 'tw1',  category: 'tw',     symbol: '00631L',  name: '元大台灣50正2', qty: 0,   priceSource: 'twse',     currency: 'TWD' },
  { id: 'cash', category: 'cash',   symbol: 'CASH',    name: '台股備用現金', qty: 300000, priceSource: 'fixed',  currency: 'TWD' },
];

const DEFAULT_LIABILITIES = [
  { id: 'usdt1', symbol: 'USDT', name: 'USDT借貸 1', qty: 5622.09,  currency: 'USD' },
  { id: 'usdt2', symbol: 'USDT', name: 'USDT借貸 2', qty: 605.3888, currency: 'USD' },
  { id: 'usdt3', symbol: 'USDT', name: 'USDT借貸 3', qty: 204.68,   currency: 'USD' },
  { id: 'twd1',  symbol: 'TWD',  name: '台幣信貸',   qty: 436894,   currency: 'TWD' },
];

const CATEGORY_META = {
  crypto:  { label: '加密貨幣', color: '#f59e0b' },
  lending: { label: '美元放貸', color: '#34d399' },
  tw:      { label: '台股',     color: '#60a5fa' },
  us:      { label: '美股',     color: '#a78bfa' },
  cash:    { label: '現金',     color: '#94a3b8' },
};

// ===== 工具函式 =====
const fmtTWD = (n) => n == null ? '--' : 'NT$' + Math.round(n).toLocaleString('zh-TW');
const fmtPct = (n) => n == null ? '--' : (n > 0 ? '+' : '') + n.toFixed(1) + '%';
const fmtNum = (n, d = 2) => n == null ? '--' : n.toLocaleString('zh-TW', { minimumFractionDigits: d, maximumFractionDigits: d });

function loadLS(key, def) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch { return def; }
}
function saveLS(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// ===== GitHub 同步 =====
const GH_OWNER = 'CACORE';
const GH_REPO  = 'portfolio-monitor';
const GH_FILE  = 'portfolio-data.json';

async function syncToGitHub(token, payload) {
  const json    = JSON.stringify(payload, null, 2);
  const content = btoa(unescape(encodeURIComponent(json)));
  const apiUrl  = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;
  let sha;
  try {
    const r = await fetch(apiUrl, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());
    sha = r.sha;
  } catch {}
  const body = { message: 'chore: sync portfolio data', content };
  if (sha) body.sha = sha;
  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('sync failed');
}

async function fetchRemoteData(token) {
  // 先走 GitHub API（即時），失敗再退回同網域檔案（Pages 部署約延遲 1 分鐘）
  try {
    const headers = { Accept: 'application/vnd.github.raw+json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`, { headers });
    if (r.ok) return await r.json();
  } catch {}
  try {
    const r = await fetch(`./${GH_FILE}?t=${Date.now()}`);
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

// ===== 價格抓取 =====
async function fetchAllPrices(assets, usdRate) {
  const prices = {};

  // Binance: BTC, BNB
  const binanceSymbols = assets.filter(a => a.priceSource === 'binance').map(a => a.symbol + 'USDT');
  if (binanceSymbols.length > 0) {
    try {
      const results = await Promise.all(
        binanceSymbols.map(s =>
          fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${s}`)
            .then(r => r.json()).catch(() => null)
        )
      );
      results.forEach((r, i) => {
        if (r && r.price) {
          const sym = binanceSymbols[i].replace('USDT', '');
          prices[sym] = parseFloat(r.price) * usdRate;
        }
      });
    } catch {}
  }

  // Bitget: BGB
  const bitgetAssets = assets.filter(a => a.priceSource === 'bitget');
  for (const a of bitgetAssets) {
    try {
      const r = await fetch(`https://api.bitget.com/api/v2/spot/market/tickers?symbol=${a.symbol}USDT`)
        .then(r => r.json()).catch(() => null);
      if (r?.data?.[0]?.lastPr) {
        prices[a.symbol] = parseFloat(r.data[0].lastPr) * usdRate;
      }
    } catch {}
  }

  // 台股：Yahoo Finance 透過 corsproxy.io 代理（不 redirect，真正伺服器端轉發）
  const twseAssets = assets.filter(a => a.priceSource === 'twse');
  for (const a of twseAssets) {
    try {
      const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${a.symbol}.TW?interval=1d&range=1d`;
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(yfUrl)}`)
        .then(res => res.json()).catch(() => null);
      const price = r?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) prices[a.symbol] = price;
    } catch {}
  }

  // 美股：Yahoo Finance 同樣走 corsproxy，代號不加 .TW，報價為 USD 需乘匯率
  const usAssets = assets.filter(a => a.priceSource === 'us');
  for (const a of usAssets) {
    try {
      const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${a.symbol}?interval=1d&range=1d`;
      const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(yfUrl)}`)
        .then(res => res.json()).catch(() => null);
      const price = r?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (price) prices[a.symbol] = price * usdRate;
    } catch {}
  }

  // Fixed: USD放貸 = 1 USD → TWD, CASH = 1 TWD
  assets.filter(a => a.priceSource === 'fixed').forEach(a => {
    prices[a.symbol] = a.currency === 'USD' ? usdRate : 1;
  });

  return prices;
}

// ===== 甜甜圈圖 =====
function DonutChart({ segments, total }) {
  const cx = 100, cy = 100, r = 85, holeR = 57;

  function polarToXY(angleDeg) {
    const rad = (angleDeg - 90) * Math.PI / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  let cumAngle = 0;
  const slices = segments
    .filter(s => s.pct > 0)
    .map(seg => {
      const startAngle = cumAngle;
      const sweep = seg.pct * 360;
      cumAngle += sweep;
      return { ...seg, startAngle, endAngle: cumAngle, sweep };
    });

  return (
    <svg viewBox="0 0 200 200" style={{ width: '100%' }}>
      {slices.map((s, i) => {
        if (s.sweep >= 359.99) {
          return <circle key={i} cx={cx} cy={cy} r={r} fill={s.color} />;
        }
        const [x1, y1] = polarToXY(s.startAngle);
        const [x2, y2] = polarToXY(s.endAngle);
        const large = s.sweep > 180 ? 1 : 0;
        return (
          <path key={i}
            d={`M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`}
            fill={s.color}
            style={{ filter: `drop-shadow(0 0 5px ${s.color}70)` }}
          />
        );
      })}
      {/* 中心圓蓋成甜甜圈 */}
      <circle cx={cx} cy={cy} r={holeR} fill="#060a0f" />
      <text x={cx} y={cy - 8} textAnchor="middle" fill="#64748b" fontSize="10" fontFamily="DM Mono">總資產</text>
      <text x={cx} y={cy + 10} textAnchor="middle" fill="#f1f5f9" fontSize="11" fontWeight="500" fontFamily="DM Mono">
        {total > 0 ? (total / 10000).toFixed(0) + '萬' : '--'}
      </text>
    </svg>
  );
}

// ===== 負債長條 =====
function LiabilityBar({ totalAssets, totalLiabilities, netWorth, fmtTWD }) {
  const liabPct = totalAssets > 0 ? Math.min((totalLiabilities / totalAssets) * 100, 100) : 0;
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid #131f2e' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, color: '#475569' }}>總資產</span>
        <span style={{ fontSize: 11, color: '#60a5fa' }}>{fmtTWD(totalAssets)}</span>
      </div>
      <div style={{ background: '#131f2e', borderRadius: 4, height: 8, marginBottom: 8, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: liabPct + '%', background: '#f87171', borderRadius: 4, transition: 'width .3s', boxShadow: '0 0 6px #f8717160' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
        <span style={{ fontSize: 11, color: '#475569' }}>總負債 <span style={{ color: '#334155' }}>({liabPct.toFixed(1)}%)</span></span>
        <span style={{ fontSize: 11, color: '#f87171' }}>{fmtTWD(totalLiabilities)}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, color: '#475569' }}>淨資產</span>
        <span style={{ fontSize: 11, color: netWorth >= 0 ? '#34d399' : '#f87171', fontWeight: 500 }}>{fmtTWD(netWorth)}</span>
      </div>
    </div>
  );
}

// ===== 編輯 Modal =====
function EditModal({ title, fields, data, onSave, onClose }) {
  const [form, setForm] = React.useState({ ...data });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 }}>
      <div style={{ background: '#0d1520', border: '1px solid #1e3a5f', borderRadius: 14, width: '100%', maxWidth: 400, padding: 28 }}>
        <div style={{ fontFamily: 'Syne', fontSize: 18, fontWeight: 700, marginBottom: 22, color: '#f1f5f9' }}>{title}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {fields.map(f => (
            <div key={f.key}>
              <div style={{ fontSize: 11, color: '#475569', marginBottom: 5 }}>{f.label}</div>
              {f.type === 'select' ? (
                <select value={form[f.key] ?? ''} onChange={e => set(f.key, e.target.value)}
                  style={{ width: '100%', background: '#131f2e', border: '1px solid #1e3a5f', borderRadius: 8, padding: '9px 12px', color: '#e2e8f0', fontFamily: 'DM Mono', fontSize: 13, outline: 'none' }}>
                  {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : (
                <input type={f.type || 'text'} value={form[f.key] ?? ''} onChange={e => set(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  style={{ width: '100%', background: '#131f2e', border: '1px solid #1e3a5f', borderRadius: 8, padding: '9px 12px', color: '#e2e8f0', fontFamily: 'DM Mono', fontSize: 13, outline: 'none' }} />
              )}
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 24, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid #1e3a5f', borderRadius: 8, padding: '8px 16px', color: '#64748b', fontFamily: 'DM Mono', fontSize: 12, cursor: 'pointer' }}>取消</button>
          <button onClick={() => onSave(form)} style={{ background: '#3b82f6', border: 'none', borderRadius: 8, padding: '8px 18px', color: '#fff', fontFamily: 'DM Mono', fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>儲存</button>
        </div>
      </div>
    </div>
  );
}

// ===== 主程式 =====
function App() {
  const [assets, setAssets] = React.useState(() => loadLS('assets_v2', DEFAULT_ASSETS));
  const [liabilities, setLiabilities] = React.useState(() => loadLS('liabilities_v2', DEFAULT_LIABILITIES));
  const [usdRate, setUsdRate] = React.useState(() => loadLS('usdRate', 32.5));
  const [prices, setPrices] = React.useState({});
  const [loading, setLoading] = React.useState(false);
  const [lastUpdated, setLastUpdated] = React.useState(null);
  const [tab, setTab] = React.useState('dashboard'); // dashboard | assets | liabilities | rebalance
  const [editAsset, setEditAsset] = React.useState(null);
  const [editLiability, setEditLiability] = React.useState(null);
  const [addMode, setAddMode] = React.useState(null); // 'asset' | 'liability'
  const [githubToken, setGithubToken] = React.useState(() => loadLS('githubToken', ''));
  const [syncStatus, setSyncStatus] = React.useState('idle'); // idle|syncing|ok|error
  const [showSettings, setShowSettings] = React.useState(false);
  const [windowWidth, setWindowWidth] = React.useState(window.innerWidth);
  React.useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const isMobile = windowWidth < 640;

  React.useEffect(() => { saveLS('assets_v2', assets); }, [assets]);
  React.useEffect(() => { saveLS('liabilities_v2', liabilities); }, [liabilities]);
  React.useEffect(() => { saveLS('usdRate', usdRate); }, [usdRate]);
  React.useEffect(() => { saveLS('githubToken', githubToken); }, [githubToken]);

  // 開啟時先拉 GitHub 上的資料，比本機新就採用（跨裝置同步）
  const skipNextSyncRef = React.useRef(true); // 首次 render 與採用遠端資料時不回推
  React.useEffect(() => {
    (async () => {
      const remote = await fetchRemoteData(githubToken);
      const localTime = loadLS('dataUpdatedAt', '');
      if (remote?.assets && remote.updatedAt && remote.updatedAt > localTime) {
        skipNextSyncRef.current = true;
        setAssets(remote.assets);
        setLiabilities(remote.liabilities || []);
        if (remote.usdRate) setUsdRate(remote.usdRate);
        saveLS('dataUpdatedAt', remote.updatedAt);
      }
    })();
  }, []);

  // 資產異動後 2 秒同步到 GitHub repo
  const syncTimer = React.useRef(null);
  React.useEffect(() => {
    if (skipNextSyncRef.current) { skipNextSyncRef.current = false; return; }
    if (!githubToken) return;
    clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(async () => {
      setSyncStatus('syncing');
      const updatedAt = new Date().toISOString();
      try {
        await syncToGitHub(githubToken, { assets, liabilities, usdRate, updatedAt });
        saveLS('dataUpdatedAt', updatedAt);
        setSyncStatus('ok');
      } catch {
        setSyncStatus('error');
      }
    }, 2000);
  }, [assets, liabilities, usdRate, githubToken]);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    const p = await fetchAllPrices(assets, usdRate);
    setPrices(p);
    setLastUpdated(new Date());
    setLoading(false);
  }, [assets, usdRate]);

  // 載入與資產異動時立即刷新，之後每 30 秒自動刷新
  React.useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30 * 1000);
    return () => clearInterval(id);
  }, [refresh]);

  // ===== 資產排序（桌面拖曳 / 手機 ▲▼）=====
  const [dragId, setDragId] = React.useState(null);
  const handleDrop = (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    setAssets(as => {
      const from = as.findIndex(x => x.id === dragId);
      const to = as.findIndex(x => x.id === targetId);
      if (from < 0 || to < 0) return as;
      const next = [...as];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDragId(null);
  };
  const moveAsset = (id, dir) => {
    setAssets(as => {
      const i = as.findIndex(x => x.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= as.length) return as;
      const next = [...as];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  // 計算資產市值（台幣）
  const enriched = assets.map(a => {
    const unitPrice = prices[a.symbol] ?? (a.currency === 'USD' ? usdRate : 1);
    const valueTWD = a.qty * unitPrice;
    return { ...a, unitPrice, valueTWD };
  });

  const totalAssets = enriched.reduce((s, a) => s + a.valueTWD, 0);

  const totalLiabilities = liabilities.reduce((s, l) => {
    const rate = l.currency === 'USD' ? usdRate : 1;
    return s + l.qty * rate;
  }, 0);

  const netWorth = totalAssets - totalLiabilities;

  // 板塊佔比
  const byCat = Object.entries(
    enriched.reduce((acc, a) => {
      acc[a.category] = (acc[a.category] || 0) + a.valueTWD;
      return acc;
    }, {})
  ).map(([cat, value]) => ({
    cat,
    value,
    pct: totalAssets > 0 ? value / totalAssets : 0,
    ...CATEGORY_META[cat],
  }));

  // 驗證加總（開 DevTools Console 可查看）
  React.useEffect(() => {
    const pctSum = byCat.reduce((s, b) => s + b.pct, 0);
    console.log('[byCat]', byCat.map(b => `${b.label} ${(b.pct*100).toFixed(1)}% NT$${Math.round(b.value).toLocaleString()}`));
    console.log('[pct sum]', pctSum.toFixed(4));
  }, [JSON.stringify(byCat)]);

  // 季度再平衡日期
  const getQuarterFirstWeekday = (year, month) => {
    const d = new Date(year, month, 1);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    return d;
  };
  const today = new Date();
  const qIdx = Math.floor(today.getMonth() / 3);
  const qMonths = [0, 3, 6, 9];
  const thisQDate = getQuarterFirstWeekday(today.getFullYear(), qMonths[qIdx]);
  const nextQIdx = (qIdx + 1) % 4;
  const nextQDate = getQuarterFirstWeekday(nextQIdx === 0 ? today.getFullYear() + 1 : today.getFullYear(), qMonths[nextQIdx]);
  const isPastThisQ = today >= thisQDate;
  const fmtDate = d => `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;

  // 00631L再平衡
  const tw631 = enriched.find(a => a.symbol === '00631L');
  const cashAsset = enriched.find(a => a.symbol === 'CASH');
  const tw631Val = tw631?.valueTWD ?? 0;
  const cashVal = cashAsset?.valueTWD ?? 0;
  const twTotal = tw631Val + cashVal;
  const twRatio = twTotal > 0 ? tw631Val / twTotal : 0;
  const rebalDiff = twTotal * 0.5 - tw631Val;
  const isUrgent  = twRatio < 0.30 || twRatio > 0.70;
  const isWarning = !isUrgent && (twRatio < 0.45 || twRatio > 0.55);

  // ===== UI =====
  const s = {
    card: { background: '#0d1520', border: '1px solid #1e3a5f', borderRadius: 12 },
    btn: (active) => ({
      background: active ? '#1e3a5f' : 'transparent',
      border: '1px solid ' + (active ? '#3b82f6' : '#1e3a5f'),
      borderRadius: 8, padding: '7px 16px', color: active ? '#93c5fd' : '#475569',
      fontFamily: 'DM Mono', fontSize: 12, cursor: 'pointer', transition: 'all .15s',
    }),
    tag: (color) => ({ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 11, background: color + '20', color }),
  };

  return (
    <div style={{ minHeight: '100vh', padding: '20px 16px', maxWidth: 960, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'space-between', alignItems: isMobile ? 'stretch' : 'flex-start', marginBottom: 24, gap: isMobile ? 12 : 0 }}>
        <div>
          <div style={{ fontFamily: 'Syne', fontSize: 24, fontWeight: 800, color: '#f1f5f9', letterSpacing: '-0.5px' }}>資產監控</div>
          <div style={{ fontSize: 11, color: '#334155', marginTop: 3 }}>
            {lastUpdated ? `更新於 ${lastUpdated.toLocaleTimeString('zh-TW')}` : '載入中...'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: isMobile ? 'space-between' : 'flex-end' }}>
          {loading && <span style={{ fontSize: 11, color: '#3b82f6', animation: 'pulse 1.5s infinite' }}>● 更新中</span>}
          {githubToken && (
            <span style={{ fontSize: 11, color: syncStatus === 'ok' ? '#34d399' : syncStatus === 'error' ? '#f87171' : syncStatus === 'syncing' ? '#f59e0b' : '#475569' }}>
              {syncStatus === 'syncing' ? '↑ 同步中' : syncStatus === 'ok' ? '✓ 已同步' : syncStatus === 'error' ? '✗ 同步失敗' : ''}
            </span>
          )}
          <button onClick={refresh} disabled={loading} style={{ ...s.btn(false), color: '#60a5fa', borderColor: '#1e3a5f' }}>↻ 更新</button>
          <button onClick={() => setShowSettings(true)} style={{ ...s.btn(false), padding: '7px 10px', fontSize: 14 }} title="設定">⚙</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: '#334155' }}>USD/TWD</span>
            <input type="number" value={usdRate} onChange={e => setUsdRate(+e.target.value)}
              style={{ width: 70, background: '#0d1520', border: '1px solid #1e3a5f', borderRadius: 8, padding: '6px 10px', color: '#93c5fd', fontFamily: 'DM Mono', fontSize: 12, outline: 'none' }} />
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3,1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: '總資產', value: fmtTWD(totalAssets), color: '#60a5fa' },
          { label: '總負債', value: fmtTWD(totalLiabilities), color: '#f87171' },
          { label: '淨資產', value: fmtTWD(netWorth), color: netWorth >= 0 ? '#34d399' : '#f87171' },
        ].map((c, i) => (
          <div key={i} style={{ ...s.card, padding: isMobile ? '12px 16px' : '14px 18px', display: isMobile ? 'flex' : 'block', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 11, color: '#334155', marginBottom: isMobile ? 0 : 6 }}>{c.label}</div>
            <div style={{ fontSize: isMobile ? 16 : 18, fontWeight: 500, color: c.color, letterSpacing: '-0.3px' }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Nav Tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[['dashboard','總覽'], ['assets','資產'], ['liabilities','負債'], ['rebalance','再平衡']].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)} style={s.btn(tab === id)}>{label}</button>
        ))}
      </div>

      {/* ===== 總覽 ===== */}
      {tab === 'dashboard' && (
        isMobile ? (
          /* ── 手機版：上下疊排 ── */
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* 圓餅圖卡片 */}
            <div style={{ ...s.card, padding: '20px 16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: '100%', maxWidth: 160, marginBottom: 20 }}>
                <DonutChart segments={byCat.map(b => ({ color: b.color, value: b.value, pct: b.pct }))} total={totalAssets} />
              </div>
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
                {byCat.map((b, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < byCat.length - 1 ? '1px solid #0d1520' : 'none', lineHeight: 1.4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: b.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>{b.label}</span>
                    </div>
                    <span style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 500 }}>
                      {totalAssets > 0 ? ((b.value / totalAssets) * 100).toFixed(1) : 0}%
                    </span>
                  </div>
                ))}
              </div>
              <LiabilityBar totalAssets={totalAssets} totalLiabilities={totalLiabilities} netWorth={netWorth} fmtTWD={fmtTWD} />
            </div>

            {/* 資產清單（card 列） */}
            <div style={s.card}>
              {enriched.map((a, i) => (
                <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: i < enriched.length - 1 ? '1px solid #0d1520' : 'none' }}>
                  <div>
                    <div style={{ color: '#f1f5f9', fontWeight: 500, fontSize: 13 }}>{a.symbol}</div>
                    <div style={{ fontSize: 10, color: '#334155', marginTop: 2 }}>{a.name}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: '#cbd5e1', fontSize: 13 }}>{fmtTWD(a.valueTWD)}</div>
                    <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>
                      單價 {fmtNum(a.unitPrice, 2)} · {totalAssets > 0 ? ((a.valueTWD / totalAssets) * 100).toFixed(1) + '%' : '--'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          /* ── 桌面版：左側 donut + 右側 table ── */
          <div style={{ display: 'grid', gridTemplateColumns: '200px 1fr', gap: 16 }}>
            <div style={{ ...s.card, padding: 20, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: '100%', maxWidth: 160, marginBottom: 20 }}>
                <DonutChart segments={byCat.map(b => ({ color: b.color, value: b.value, pct: b.pct }))} total={totalAssets} />
              </div>
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column' }}>
                {byCat.map((b, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: i < byCat.length - 1 ? '1px solid #0d1520' : 'none', lineHeight: 1.4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: b.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>{b.label}</span>
                    </div>
                    <span style={{ fontSize: 12, color: '#cbd5e1', fontWeight: 500 }}>
                      {totalAssets > 0 ? ((b.value / totalAssets) * 100).toFixed(1) : 0}%
                    </span>
                  </div>
                ))}
              </div>
              <LiabilityBar totalAssets={totalAssets} totalLiabilities={totalLiabilities} netWorth={netWorth} fmtTWD={fmtTWD} />
            </div>
            <div style={{ ...s.card, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #131f2e' }}>
                    {['標的', '板塊', '數量', '單價(TWD)', '市值', '佔總資產'].map((h, i) => (
                      <th key={i} style={{ padding: '11px 14px', textAlign: i >= 2 ? 'right' : 'left', color: '#334155', fontWeight: 400 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {enriched.map(a => (
                    <tr key={a.id} style={{ borderBottom: '1px solid #0d1520' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#131f2e'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ color: '#f1f5f9', fontWeight: 500 }}>{a.symbol}</div>
                        <div style={{ fontSize: 10, color: '#334155' }}>{a.name}</div>
                      </td>
                      <td style={{ padding: '10px 14px' }}>
                        <span style={s.tag(CATEGORY_META[a.category]?.color || '#94a3b8')}>{CATEGORY_META[a.category]?.label}</span>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#94a3b8' }}>{fmtNum(a.qty, a.qty < 1 ? 8 : 2)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#94a3b8' }}>{fmtNum(a.unitPrice, 2)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#cbd5e1' }}>{fmtTWD(a.valueTWD)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#475569' }}>
                        {totalAssets > 0 ? ((a.valueTWD / totalAssets) * 100).toFixed(1) + '%' : '--'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {/* ===== 資產管理 ===== */}
      {tab === 'assets' && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #131f2e' }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>持倉管理</span>
            <button onClick={() => setAddMode('asset')} style={{ ...s.btn(true), color: '#93c5fd' }}>+ 新增</button>
          </div>
          {isMobile ? (
            /* 手機版：card list */
            enriched.map((a, i) => (
              <div key={a.id} style={{ padding: '14px 16px', borderBottom: i < enriched.length - 1 ? '1px solid #0d1520' : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                  <div>
                    <div style={{ color: '#f1f5f9', fontWeight: 500, fontSize: 14 }}>{a.symbol}</div>
                    <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>{a.name}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ color: '#cbd5e1', fontSize: 14 }}>{fmtTWD(a.valueTWD)}</div>
                    <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>
                      {totalAssets > 0 ? ((a.valueTWD / totalAssets) * 100).toFixed(1) + '%' : '--'}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={s.tag(CATEGORY_META[a.category]?.color || '#94a3b8')}>{CATEGORY_META[a.category]?.label}</span>
                    <span style={{ fontSize: 11, color: '#334155' }}>數量 {fmtNum(a.qty, a.qty < 1 ? 6 : 2)}</span>
                    <span style={{ fontSize: 11, color: '#475569' }}>單價 {fmtNum(a.unitPrice, 2)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => moveAsset(a.id, -1)} disabled={i === 0}
                      style={{ ...s.btn(false), padding: '4px 10px', fontSize: 12, opacity: i === 0 ? 0.3 : 1 }}>▲</button>
                    <button onClick={() => moveAsset(a.id, 1)} disabled={i === enriched.length - 1}
                      style={{ ...s.btn(false), padding: '4px 10px', fontSize: 12, opacity: i === enriched.length - 1 ? 0.3 : 1 }}>▼</button>
                    <button onClick={() => setEditAsset(a)} style={{ ...s.btn(false), padding: '4px 12px', fontSize: 12 }}>編輯</button>
                    <button onClick={() => setAssets(as => as.filter(x => x.id !== a.id))}
                      style={{ ...s.btn(false), padding: '4px 12px', fontSize: 12, color: '#f87171', borderColor: '#3f1010' }}>刪除</button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            /* 桌面版：table */
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #131f2e' }}>
                    {['', '代號', '名稱', '板塊', '數量', '單價(TWD)', '市值', ''].map((h, i) => (
                      <th key={i} style={{ padding: '11px 14px', textAlign: i >= 4 ? 'right' : 'left', color: '#334155', fontWeight: 400 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {enriched.map(a => (
                    <tr key={a.id} draggable
                      onDragStart={() => setDragId(a.id)}
                      onDragOver={e => e.preventDefault()}
                      onDrop={() => handleDrop(a.id)}
                      onDragEnd={() => setDragId(null)}
                      style={{ borderBottom: '1px solid #0d1520', opacity: dragId === a.id ? 0.4 : 1 }}>
                      <td style={{ padding: '10px 0 10px 14px', color: '#334155', cursor: 'grab', width: 18, fontSize: 14 }} title="拖曳排序">⠿</td>
                      <td style={{ padding: '10px 14px', color: '#f1f5f9', fontWeight: 500 }}>{a.symbol}</td>
                      <td style={{ padding: '10px 14px', color: '#64748b' }}>{a.name}</td>
                      <td style={{ padding: '10px 14px' }}><span style={s.tag(CATEGORY_META[a.category]?.color || '#94a3b8')}>{CATEGORY_META[a.category]?.label}</span></td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#94a3b8' }}>{fmtNum(a.qty, a.qty < 1 ? 8 : 2)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#94a3b8' }}>{fmtNum(a.unitPrice, 2)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#cbd5e1' }}>{fmtTWD(a.valueTWD)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button onClick={() => setEditAsset(a)} style={{ ...s.btn(false), padding: '4px 10px' }}>編輯</button>
                          <button onClick={() => setAssets(as => as.filter(x => x.id !== a.id))}
                            style={{ ...s.btn(false), padding: '4px 10px', color: '#f87171', borderColor: '#3f1010' }}>刪除</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ===== 負債管理 ===== */}
      {tab === 'liabilities' && (
        <div style={s.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid #131f2e' }}>
            <span style={{ fontSize: 13, color: '#94a3b8' }}>負債管理</span>
            <button onClick={() => setAddMode('liability')} style={{ ...s.btn(true), color: '#93c5fd' }}>+ 新增</button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 360 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #131f2e' }}>
                  {['名稱', '幣別', '換算台幣', ''].map((h, i) => (
                    <th key={i} style={{ padding: '11px 14px', textAlign: i >= 1 ? 'right' : 'left', color: '#334155', fontWeight: 400, whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {liabilities.map(l => {
                  const rate = l.currency === 'USD' ? usdRate : 1;
                  const valueTWD = l.qty * rate;
                  return (
                    <tr key={l.id} style={{ borderBottom: '1px solid #0d1520' }}>
                      <td style={{ padding: '10px 14px' }}>
                        <div style={{ color: '#f1f5f9' }}>{l.name}</div>
                        <div style={{ fontSize: 10, color: '#f87171' }}>{fmtNum(l.qty, 2)} {l.currency}</div>
                      </td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#334155', whiteSpace: 'nowrap' }}>{l.currency}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right', color: '#f87171', whiteSpace: 'nowrap' }}>{fmtTWD(valueTWD)}</td>
                      <td style={{ padding: '10px 14px', textAlign: 'right' }}>
                        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                          <button onClick={() => setEditLiability(l)} style={{ ...s.btn(false), padding: '4px 10px' }}>編輯</button>
                          <button onClick={() => setLiabilities(ls => ls.filter(x => x.id !== l.id))}
                            style={{ ...s.btn(false), padding: '4px 10px', color: '#f87171', borderColor: '#3f1010' }}>刪</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                <tr style={{ borderTop: '1px solid #1e3a5f' }}>
                  <td colSpan={2} style={{ padding: '12px 14px', color: '#475569', fontSize: 11 }}>負債合計</td>
                  <td style={{ padding: '12px 14px', textAlign: 'right', color: '#f87171', fontWeight: 500 }}>{fmtTWD(totalLiabilities)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ===== 再平衡 ===== */}
      {tab === 'rebalance' && (() => {
        const statusColor = isUrgent ? '#f87171' : isWarning ? '#f59e0b' : '#34d399';
        const statusLabel = isUrgent ? '❗ 需立即再平衡' : isWarning ? '⚠️ 比例偏移中' : '✓ 比例平衡';
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* 季度排程 */}
            <div style={{ ...s.card, padding: 20 }}>
              <div style={{ fontFamily: 'Syne', fontSize: 15, fontWeight: 700, color: '#f1f5f9', marginBottom: 14 }}>季度再平衡排程</div>
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 10 }}>
                <div style={{ background: '#060a0f', borderRadius: 10, padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, color: '#475569', marginBottom: 5 }}>本季開盤首日（Q{qIdx + 1}）</div>
                  <div style={{ fontSize: 15, fontWeight: 500, color: isPastThisQ ? '#34d399' : '#f59e0b' }}>
                    {fmtDate(thisQDate)} {isPastThisQ ? '· 已過' : '· 待執行'}
                  </div>
                </div>
                <div style={{ background: '#060a0f', borderRadius: 10, padding: '12px 16px' }}>
                  <div style={{ fontSize: 11, color: '#475569', marginBottom: 5 }}>下季開盤首日（Q{nextQIdx === 0 ? 1 : nextQIdx + 1}）</div>
                  <div style={{ fontSize: 15, fontWeight: 500, color: '#60a5fa' }}>{fmtDate(nextQDate)}</div>
                </div>
              </div>
            </div>

            {/* 00631L 50/50 */}
            <div style={{ ...s.card, padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
                <div style={{ fontFamily: 'Syne', fontSize: 15, fontWeight: 700, color: '#f1f5f9' }}>00631L / 現金</div>
                <span style={{ padding: '3px 10px', borderRadius: 20, background: statusColor + '22', color: statusColor, fontSize: 12 }}>{statusLabel}</span>
              </div>

              {/* 數值 */}
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2,1fr)', gap: 10, marginBottom: 18 }}>
                {[
                  { label: '00631L 市值', value: fmtTWD(tw631Val), color: '#60a5fa' },
                  { label: '現金備用',    value: fmtTWD(cashVal),  color: '#94a3b8' },
                ].map((c, i) => (
                  <div key={i} style={{ background: '#060a0f', borderRadius: 10, padding: '12px 16px', display: isMobile ? 'flex' : 'block', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 11, color: '#475569', marginBottom: isMobile ? 0 : 4 }}>{c.label}</div>
                    <div style={{ fontSize: 15, color: c.color }}>{c.value}</div>
                  </div>
                ))}
              </div>

              {/* 4區間進度條 */}
              <div style={{ marginBottom: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
                  <span style={{ color: statusColor, fontWeight: 500 }}>目前 {(twRatio * 100).toFixed(1)}%</span>
                  <span style={{ color: '#475569' }}>目標 50%</span>
                </div>
                <div style={{ position: 'relative', background: '#060a0f', borderRadius: 6, height: 12 }}>
                  <div style={{ position: 'absolute', left: '0%',  width: '30%', height: '100%', background: '#f8717112', borderRadius: '6px 0 0 6px' }} />
                  <div style={{ position: 'absolute', left: '30%', width: '20%', height: '100%', background: '#f59e0b12' }} />
                  <div style={{ position: 'absolute', left: '50%', width: '20%', height: '100%', background: '#f59e0b12' }} />
                  <div style={{ position: 'absolute', left: '70%', width: '30%', height: '100%', background: '#f8717112', borderRadius: '0 6px 6px 0' }} />
                  <div style={{ position: 'absolute', left: 0, width: Math.min(twRatio * 100, 100) + '%', height: '100%', background: statusColor, borderRadius: 6, transition: 'width .3s', opacity: 0.9 }} />
                  <div style={{ position: 'absolute', left: '50%', top: 0, width: 2, height: '100%', background: '#1e3a5f' }} />
                </div>
                <div style={{ display: 'flex', fontSize: 10, color: '#334155', marginTop: 5, position: 'relative', height: 14 }}>
                  <span style={{ position: 'absolute', left: '30%', transform: 'translateX(-50%)' }}>30%</span>
                  <span style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', color: '#475569' }}>50%</span>
                  <span style={{ position: 'absolute', left: '70%', transform: 'translateX(-50%)' }}>70%</span>
                </div>
              </div>

              {/* 提前警示 */}
              {isUrgent && (
                <div style={{ background: '#f871711a', border: '1px solid #f8717140', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
                  <div style={{ color: '#f87171', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>
                    ❗ 比例 {(twRatio*100).toFixed(1)} / {(100-twRatio*100).toFixed(1)} 已觸發提前再平衡（閾值 70/30）
                  </div>
                  <div style={{ color: '#94a3b8', fontSize: 12 }}>建議不等季度，立即執行再平衡</div>
                </div>
              )}
              {isWarning && (
                <div style={{ background: '#f59e0b1a', border: '1px solid #f59e0b40', borderRadius: 10, padding: '14px 16px', marginBottom: 12 }}>
                  <div style={{ color: '#f59e0b', fontSize: 13 }}>
                    ⚠️ 比例 {(twRatio*100).toFixed(1)} / {(100-twRatio*100).toFixed(1)} 已偏離建議區間（45–55%）
                  </div>
                </div>
              )}

              {/* 操作建議 */}
              <div style={{ background: '#060a0f', borderRadius: 10, padding: '16px 18px' }}>
                {Math.abs(rebalDiff) < 5000 ? (
                  <div style={{ color: '#34d399', fontSize: 13 }}>✓ 目前比例平衡，無需操作</div>
                ) : rebalDiff > 0 ? (
                  <div>
                    <div style={{ color: '#60a5fa', fontSize: 13, marginBottom: 6 }}>▲ 建議買進 00631L</div>
                    <div style={{ color: '#f1f5f9', fontSize: 20, fontWeight: 500 }}>{fmtTWD(rebalDiff)}</div>
                    <div style={{ color: '#475569', fontSize: 11, marginTop: 4 }}>從現金買入，使標的回到 50%</div>
                  </div>
                ) : (
                  <div>
                    <div style={{ color: '#f59e0b', fontSize: 13, marginBottom: 6 }}>▼ 建議賣出 00631L</div>
                    <div style={{ color: '#f1f5f9', fontSize: 20, fontWeight: 500 }}>{fmtTWD(Math.abs(rebalDiff))}</div>
                    <div style={{ color: '#475569', fontSize: 11, marginTop: 4 }}>賣出轉入現金，使標的回到 50%</div>
                  </div>
                )}
              </div>
            </div>

            {/* 板塊佔比 */}
            <div style={{ ...s.card, padding: 20 }}>
              <div style={{ fontFamily: 'Syne', fontSize: 15, fontWeight: 700, color: '#f1f5f9', marginBottom: 16 }}>板塊佔比</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {byCat.map(b => (
                  <div key={b.cat}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 5 }}>
                      <span style={{ color: b.color }}>{b.label}</span>
                      <span style={{ color: '#94a3b8' }}>{fmtTWD(b.value)} · {(b.pct * 100).toFixed(1)}%</span>
                    </div>
                    <div style={{ background: '#060a0f', borderRadius: 3, height: 6 }}>
                      <div style={{ height: '100%', width: (b.pct * 100) + '%', background: b.color, borderRadius: 3, transition: 'width .3s', boxShadow: `0 0 6px ${b.color}60` }} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* ===== 編輯資產 Modal ===== */}
      {editAsset && (
        <EditModal title="編輯資產" data={editAsset}
          fields={[
            { key: 'symbol', label: '代號' },
            { key: 'name', label: '名稱' },
            { key: 'category', label: '板塊', type: 'select', options: Object.entries(CATEGORY_META).map(([v, m]) => ({ value: v, label: m.label })) },
            { key: 'qty', label: '數量', type: 'number' },
            { key: 'priceSource', label: '報價來源', type: 'select', options: [
              { value: 'binance', label: 'Binance API (BTC/BNB等)' },
              { value: 'bitget', label: 'Bitget API (BGB等)' },
              { value: 'twse', label: '台灣證交所 (台股)' },
              { value: 'us', label: '美股 (Yahoo Finance)' },
              { value: 'fixed', label: '固定（依幣別換算）' },
            ]},
            { key: 'currency', label: '計價幣別', type: 'select', options: [{ value: 'USD', label: 'USD' }, { value: 'TWD', label: 'TWD' }] },
          ]}
          onSave={form => {
            setAssets(as => as.map(a => a.id === editAsset.id ? { ...a, ...form, qty: parseFloat(form.qty) } : a));
            setEditAsset(null);
          }}
          onClose={() => setEditAsset(null)} />
      )}

      {/* ===== 新增資產 Modal ===== */}
      {addMode === 'asset' && (
        <EditModal title="新增資產" data={{ symbol: '', name: '', category: 'crypto', qty: '', priceSource: 'binance', currency: 'USD' }}
          fields={[
            { key: 'symbol', label: '代號（例如 BTC）' },
            { key: 'name', label: '名稱' },
            { key: 'category', label: '板塊', type: 'select', options: Object.entries(CATEGORY_META).map(([v, m]) => ({ value: v, label: m.label })) },
            { key: 'qty', label: '數量', type: 'number' },
            { key: 'priceSource', label: '報價來源', type: 'select', options: [
              { value: 'binance', label: 'Binance API (BTC/BNB等)' },
              { value: 'bitget', label: 'Bitget API (BGB等)' },
              { value: 'twse', label: '台灣證交所 (台股)' },
              { value: 'us', label: '美股 (Yahoo Finance)' },
              { value: 'fixed', label: '固定（依幣別換算）' },
            ]},
            { key: 'currency', label: '計價幣別', type: 'select', options: [{ value: 'USD', label: 'USD' }, { value: 'TWD', label: 'TWD' }] },
          ]}
          onSave={form => {
            const newAsset = { ...form, id: Date.now().toString(), qty: parseFloat(form.qty) };
            setAssets(as => [...as, newAsset]);
            setAddMode(null);
          }}
          onClose={() => setAddMode(null)} />
      )}

      {/* ===== 編輯負債 Modal ===== */}
      {editLiability && (
        <EditModal title="編輯負債" data={editLiability}
          fields={[
            { key: 'name', label: '名稱' },
            { key: 'qty', label: '金額', type: 'number' },
            { key: 'currency', label: '幣別', type: 'select', options: [{ value: 'USD', label: 'USD' }, { value: 'TWD', label: 'TWD' }] },
          ]}
          onSave={form => {
            setLiabilities(ls => ls.map(l => l.id === editLiability.id ? { ...l, ...form, qty: parseFloat(form.qty) } : l));
            setEditLiability(null);
          }}
          onClose={() => setEditLiability(null)} />
      )}

      {/* ===== 新增負債 Modal ===== */}
      {addMode === 'liability' && (
        <EditModal title="新增負債" data={{ name: '', qty: '', currency: 'TWD' }}
          fields={[
            { key: 'name', label: '名稱' },
            { key: 'qty', label: '金額', type: 'number' },
            { key: 'currency', label: '幣別', type: 'select', options: [{ value: 'USD', label: 'USD' }, { value: 'TWD', label: 'TWD' }] },
          ]}
          onSave={form => {
            setLiabilities(ls => [...ls, { ...form, id: Date.now().toString(), qty: parseFloat(form.qty) }]);
            setAddMode(null);
          }}
          onClose={() => setAddMode(null)} />
      )}

      {/* ===== GitHub 同步設定 Modal ===== */}
      {showSettings && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 16 }}>
          <div style={{ background: '#0d1520', border: '1px solid #1e3a5f', borderRadius: 14, width: '100%', maxWidth: 420, padding: 28 }}>
            <div style={{ fontFamily: 'Syne', fontSize: 18, fontWeight: 700, marginBottom: 8, color: '#f1f5f9' }}>GitHub 同步設定</div>
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 6, lineHeight: 1.6 }}>
              在終端機執行 <code style={{ background: '#131f2e', padding: '2px 6px', borderRadius: 4, color: '#93c5fd' }}>gh auth token</code> 取得 Token 後貼入。
              Token 只存在瀏覽器，不會上傳至 repo。
            </div>
            <div style={{ fontSize: 11, color: '#475569', marginBottom: 5, marginTop: 16 }}>Personal Access Token</div>
            <input
              type="password"
              value={githubToken}
              onChange={e => { setGithubToken(e.target.value); setSyncStatus('idle'); }}
              placeholder="gho_..."
              style={{ width: '100%', background: '#131f2e', border: '1px solid #1e3a5f', borderRadius: 8, padding: '9px 12px', color: '#e2e8f0', fontFamily: 'DM Mono', fontSize: 13, outline: 'none', marginBottom: 8 }}
            />
            {githubToken && (
              <div style={{ fontSize: 11, marginBottom: 16, color: syncStatus === 'ok' ? '#34d399' : syncStatus === 'error' ? '#f87171' : '#475569' }}>
                {syncStatus === 'ok' ? '✓ 同步成功，check.py 將自動讀取最新持倉' : syncStatus === 'error' ? '✗ 同步失敗，請確認 Token 有 Contents:write 權限' : syncStatus === 'syncing' ? '↑ 同步中...' : '待存取後自動同步'}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowSettings(false)} style={{ background: '#3b82f6', border: 'none', borderRadius: 8, padding: '8px 20px', color: '#fff', fontFamily: 'DM Mono', fontSize: 12, cursor: 'pointer' }}>完成</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
        input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; }
        select option { background: #0d1520; }
      `}</style>
    </div>
  );
}

// ===== 密碼鎖 =====
function pwHash(s) {
  // btoa 簡易雜湊，足夠擋住一般人
  return btoa(unescape(encodeURIComponent('pm:' + s)));
}

function PasswordGate({ children }) {
  const [authed, setAuthed] = React.useState(() => sessionStorage.getItem('authed') === '1');
  const [input, setInput]   = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [error, setError]   = React.useState('');
  const hasHash = !!loadLS('pwHash', '');

  if (authed) return children;

  const doSetup = () => {
    if (input.length < 4) { setError('密碼至少 4 個字元'); return; }
    if (input !== confirm) { setError('兩次輸入不一致'); return; }
    saveLS('pwHash', pwHash(input));
    sessionStorage.setItem('authed', '1');
    setAuthed(true);
  };

  const doLogin = () => {
    if (pwHash(input) === loadLS('pwHash', '')) {
      sessionStorage.setItem('authed', '1');
      setAuthed(true);
    } else {
      setError('密碼錯誤');
      setInput('');
    }
  };

  const onKey = (e) => { if (e.key === 'Enter') hasHash ? doLogin() : doSetup(); };
  const inp = { width: '100%', background: '#131f2e', border: '1px solid #1e3a5f', borderRadius: 8, padding: '10px 14px', color: '#e2e8f0', fontFamily: 'DM Mono', fontSize: 14, outline: 'none', marginBottom: 12 };
  const btn = { width: '100%', background: '#3b82f6', border: 'none', borderRadius: 8, padding: '10px', color: '#fff', fontFamily: 'DM Mono', fontSize: 14, fontWeight: 500, cursor: 'pointer' };

  return (
    <div style={{ minHeight: '100vh', background: '#060a0f', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: '#0d1520', border: '1px solid #1e3a5f', borderRadius: 16, width: '100%', maxWidth: 360, padding: 32 }}>
        <div style={{ fontFamily: 'Syne', fontSize: 22, fontWeight: 800, color: '#f1f5f9', marginBottom: 6 }}>資產監控</div>
        <div style={{ fontSize: 12, color: '#475569', marginBottom: 24 }}>{hasHash ? '請輸入密碼' : '首次使用，請設定密碼'}</div>
        <input type="password" value={input} onChange={e => { setInput(e.target.value); setError(''); }}
          onKeyDown={onKey} placeholder={hasHash ? '密碼' : '設定密碼'} style={inp} autoFocus />
        {!hasHash && (
          <input type="password" value={confirm} onChange={e => { setConfirm(e.target.value); setError(''); }}
            onKeyDown={onKey} placeholder="確認密碼" style={inp} />
        )}
        {error && <div style={{ color: '#f87171', fontSize: 12, marginBottom: 12 }}>{error}</div>}
        <button onClick={hasHash ? doLogin : doSetup} style={btn}>
          {hasHash ? '進入' : '設定並進入'}
        </button>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<PasswordGate><App /></PasswordGate>);

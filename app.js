'use strict';

// ---------- настройки ----------
const LS_KEY = 'webcamZoom.cfg';
const cfg = Object.assign({
  url: 'ws://127.0.0.1:4455',
  password: '',
  scene: '',
  itemId: null,
  speed: 0.8,     // скорость нарастания зума (лог. единицы в секунду)
  maxZoom: 4,
  smooth: 8,      // жёсткость сглаживания: чем больше, тем быстрее догоняет цель
  autoConnect: false,
}, safeParse(localStorage.getItem(LS_KEY)));

function safeParse(s) { try { return JSON.parse(s) || {}; } catch { return {}; } }
function saveCfg() { try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {} }

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const el = {
  status: $('status'), url: $('url'), password: $('password'), connect: $('connect'),
  scene: $('scene'), item: $('item'), refresh: $('refresh'),
  speed: $('speed'), maxZoom: $('maxZoom'), smooth: $('smooth'), restore: $('restore'),
  pad: $('pad'), preview: $('preview'), rect: $('rect'), handle: $('handle'), info: $('info'), settings: $('settings'),
};
el.url.value = cfg.url;
el.password.value = cfg.password;
el.speed.value = cfg.speed;
el.maxZoom.value = cfg.maxZoom;
el.smooth.value = cfg.smooth;

function info(msg) { el.info.textContent = msg || ''; }

// ---------- OBS ----------
const obs = new OBSWebSocket();
let connected = false;

// Управляемый источник и все его элементы во всех сценах (зум синхронный)
let target = null; // { sourceName, srcW, srcH, items: [{ sceneName, sceneItemId }] }

// Состояние зума (нормализованные координаты центра 0..1)
const st = {
  zoom: 1, cx: 0.5, cy: 0.5,
  tZoom: 1, tCx: 0.5, tCy: 0.5,
  holding: 0, px: 0.5, py: 0.5, // holding: 1 = ЛКМ (зум), -1 = ПКМ (отзум)
  lastSent: '', inflight: false,
};

function setStatus(on) {
  connected = on;
  el.status.textContent = on ? 'online' : 'offline';
  el.status.className = 'status ' + (on ? 'on' : 'off');
  el.connect.textContent = on ? 'Отключить' : 'Подключить';
}

async function connect() {
  if (connected) { cfg.autoConnect = false; saveCfg(); await obs.disconnect(); return; }
  cfg.url = el.url.value.trim() || 'ws://127.0.0.1:4455';
  cfg.password = el.password.value;
  saveCfg();
  try {
    info('Подключаюсь…');
    await obs.connect(cfg.url, cfg.password || undefined);
    setStatus(true);
    cfg.autoConnect = true; saveCfg();
    info('');
    await loadScenes();
    el.settings.open = false;
  } catch (e) {
    setStatus(false);
    info('Не удалось подключиться: ' + (e.message || e));
  }
}

obs.on('ConnectionClosed', () => { setStatus(false); target = null; });

async function loadScenes() {
  const { scenes, currentProgramSceneName } = await obs.call('GetSceneList');
  el.scene.innerHTML = '';
  // GetSceneList отдаёт сцены в обратном порядке относительно UI
  for (const s of [...scenes].reverse()) {
    el.scene.add(new Option(s.sceneName, s.sceneName));
  }
  const names = scenes.map((s) => s.sceneName);
  el.scene.value = names.includes(cfg.scene) ? cfg.scene : currentProgramSceneName;
  await loadItems();
}

const CAMERA_KINDS = ['dshow_input', 'av_capture_input', 'av_capture_input_v2', 'v4l2_input', 'macos_avcapture'];

async function loadItems() {
  const sceneName = el.scene.value;
  if (!sceneName) return;
  const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });
  el.item.innerHTML = '';
  for (const it of [...sceneItems].reverse()) {
    el.item.add(new Option(it.sourceName, String(it.sceneItemId)));
  }
  const ids = sceneItems.map((i) => i.sceneItemId);
  let pick = null;
  if (sceneName === cfg.scene && ids.includes(cfg.itemId)) pick = cfg.itemId;
  else {
    const cam = sceneItems.find((i) => CAMERA_KINDS.includes(i.inputKind));
    pick = cam ? cam.sceneItemId : (sceneItems[0] && sceneItems[0].sceneItemId);
  }
  if (pick != null) el.item.value = String(pick);
  await selectItem();
}

const ORIG_PREFIX = 'webcamZoom.orig:';
const origKey = (sceneName, id) => `${ORIG_PREFIX}${sceneName}:${id}`;

// Все элементы с этим источником во всех сценах (и внутри групп)
async function findSourceItems(sourceName) {
  const { scenes } = await obs.call('GetSceneList');
  const found = [];
  const seenGroups = new Set();
  for (const { sceneName } of scenes) {
    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });
    for (const it of sceneItems) {
      if (it.sourceName === sourceName) found.push({ sceneName, sceneItemId: it.sceneItemId });
      if (it.isGroup && !seenGroups.has(it.sourceName)) {
        seenGroups.add(it.sourceName);
        const { sceneItems: inner } = await obs.call('GetGroupSceneItemList', { sceneName: it.sourceName });
        for (const g of inner) {
          if (g.sourceName === sourceName) found.push({ sceneName: it.sourceName, sceneItemId: g.sceneItemId });
        }
      }
    }
  }
  return found;
}

// Готовит элемент к зуму: сохраняет исходный вид, ставит bounds (Stretch) и обнуляет crop.
// Возвращает текущий transform (после подготовки).
async function prepareItem({ sceneName, sceneItemId }) {
  const { sceneItemTransform: t } = await obs.call('GetSceneItemTransform', { sceneName, sceneItemId });
  if (!t.sourceWidth || !t.sourceHeight) return t;

  // Запоминаем исходный transform один раз, чтобы потом вернуть как было
  const key = origKey(sceneName, sceneItemId);
  if (!localStorage.getItem(key)) {
    const orig = {
      sceneName, sceneItemId,
      cropLeft: t.cropLeft, cropRight: t.cropRight, cropTop: t.cropTop, cropBottom: t.cropBottom,
      boundsType: t.boundsType, boundsWidth: t.boundsWidth, boundsHeight: t.boundsHeight,
      boundsAlignment: t.boundsAlignment,
    };
    try { localStorage.setItem(key, JSON.stringify(orig)); } catch {}
  }

  // Фиксируем размер элемента на сцене через bounding box.
  // Дальше зум = только crop, а bounds растягивают обрезанную часть на тот же прямоугольник.
  if (t.boundsType !== 'OBS_BOUNDS_STRETCH') {
    const bw = Math.max(1, t.width);
    const bh = Math.max(1, bw * t.sourceHeight / t.sourceWidth); // пропорции исходника, без искажений
    await obs.call('SetSceneItemTransform', {
      sceneName, sceneItemId,
      sceneItemTransform: {
        boundsType: 'OBS_BOUNDS_STRETCH', boundsWidth: bw, boundsHeight: bh, boundsAlignment: 0,
        cropLeft: 0, cropRight: 0, cropTop: 0, cropBottom: 0,
      },
    });
    t.cropLeft = t.cropRight = t.cropTop = t.cropBottom = 0;
  }
  return t;
}

async function selectItem() {
  target = null;
  const sceneName = el.scene.value;
  const sceneItemId = Number(el.item.value);
  if (!sceneName || !sceneItemId) return;

  const opt = el.item.selectedOptions[0];
  const sourceName = opt ? opt.textContent : '';

  // Зум берём с выбранного элемента, чтобы после перезагрузки панели не было скачка
  const t = await prepareItem({ sceneName, sceneItemId });
  if (!t.sourceWidth || !t.sourceHeight) {
    info('У источника нулевой размер — камера выключена? Нажми ⟳, когда она заработает.');
    return;
  }
  const srcW = t.sourceWidth, srcH = t.sourceHeight;
  const w = srcW - t.cropLeft - t.cropRight;
  const h = srcH - t.cropTop - t.cropBottom;
  st.zoom = st.tZoom = w > 0 ? Math.max(1, srcW / w) : 1;
  st.cx = st.tCx = w > 0 ? (t.cropLeft + w / 2) / srcW : 0.5;
  st.cy = st.tCy = h > 0 ? (t.cropTop + h / 2) / srcH : 0.5;

  el.pad.style.aspectRatio = `${srcW} / ${srcH}`;
  target = { sourceName, srcW, srcH, items: [{ sceneName, sceneItemId }] };
  cfg.scene = sceneName; cfg.itemId = sceneItemId; saveCfg();
  await rescanItems();
}

// Находит все элементы источника во всех сценах и готовит их; следующий тик разошлёт им crop
async function rescanItems() {
  if (!target) return;
  const t0 = target;
  const items = await findSourceItems(t0.sourceName);
  for (const it of items) {
    try { await prepareItem(it); } catch (e) { /* элемент мог исчезнуть — пропускаем */ }
  }
  if (target !== t0) return; // за это время выбрали другой источник
  target.items = items;
  st.lastSent = ''; // разослать текущий crop всем элементам, включая новые
  const scenes = new Set(items.map((i) => i.sceneName)).size;
  info(`${t0.sourceName}: ${t0.srcW}×${t0.srcH} · элементов: ${items.length}, сцен: ${scenes}`);
}

// Перескан при изменениях в сценах (с задержкой, чтобы склеить пачку событий)
let rescanTimer = null;
function scheduleRescan() {
  clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => rescanItems().catch((e) => info(e.message)), 300);
}
for (const ev of ['SceneItemCreated', 'SceneItemRemoved', 'SceneCreated', 'SceneRemoved', 'SceneNameChanged']) {
  obs.on(ev, scheduleRescan);
}
obs.on('InputNameChanged', ({ oldInputName, inputName }) => {
  if (target && target.sourceName === oldInputName) target.sourceName = inputName;
  scheduleRescan();
});

// Возвращает исходный вид всем элементам, которые панель когда-либо трогала
async function restoreOriginal() {
  if (!connected) return;
  target = null;
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(ORIG_PREFIX)) keys.push(k);
  }
  if (!keys.length) { info('Нет сохранённого исходного вида.'); return; }

  let ok = 0, fail = 0;
  for (const key of keys) {
    const orig = safeParse(localStorage.getItem(key));
    // Старый формат записи без sceneName/sceneItemId — достаём из ключа
    let { sceneName, sceneItemId } = orig;
    if (!sceneName) {
      const rest = key.slice(ORIG_PREFIX.length);
      const i = rest.lastIndexOf(':');
      sceneName = rest.slice(0, i);
      sceneItemId = Number(rest.slice(i + 1));
    }
    const tr = {
      cropLeft: orig.cropLeft, cropRight: orig.cropRight, cropTop: orig.cropTop, cropBottom: orig.cropBottom,
      boundsType: orig.boundsType, boundsAlignment: orig.boundsAlignment,
    };
    // obs-websocket не принимает bounds < 1
    if (orig.boundsWidth >= 1 && orig.boundsHeight >= 1) {
      tr.boundsWidth = orig.boundsWidth; tr.boundsHeight = orig.boundsHeight;
    }
    try {
      await obs.call('SetSceneItemTransform', { sceneName, sceneItemId, sceneItemTransform: tr });
      ok++;
    } catch (e) {
      fail++; // элемент удалён или сцена переименована — запись больше не нужна
    }
    localStorage.removeItem(key);
  }
  info(`Исходный вид восстановлен: ${ok}` + (fail ? `, не найдено: ${fail}` : '') +
    '. Управление выключено — выбери элемент снова, чтобы включить.');
}

// ---------- превью (скриншоты исходника, без зума) ----------
async function previewLoop() {
  for (;;) {
    if (connected && target) {
      try {
        const { imageData } = await obs.call('GetSourceScreenshot', {
          sourceName: target.sourceName, imageFormat: 'jpg', imageWidth: 480, imageCompressionQuality: 70,
        });
        el.preview.src = imageData;
      } catch (e) {
        await sleep(1000);
      }
      await sleep(70);
    } else {
      await sleep(300);
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- мышь ----------
function norm(e) {
  const r = el.pad.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
    y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
  };
}

// Ручка в углу рамки: перетаскивание без изменения зума (относительно точки захвата)
const pan = { active: false, x0: 0, y0: 0, cx0: 0.5, cy0: 0.5 };

// ЛКМ — зум к точке, ПКМ — отзум, ЛКМ на ручке — двигать рамку
el.pad.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 && e.button !== 2) return;
  el.pad.setPointerCapture(e.pointerId);
  const p = norm(e);
  st.px = p.x; st.py = p.y;
  if (e.button === 0 && e.target === el.handle) {
    clampTargetCenter();
    Object.assign(pan, { active: true, x0: p.x, y0: p.y, cx0: st.tCx, cy0: st.tCy });
  } else {
    st.holding = e.button === 0 ? 1 : -1;
  }
});
el.pad.addEventListener('pointermove', (e) => {
  const p = norm(e);
  st.px = p.x; st.py = p.y;
  if (pan.active) {
    st.tCx = pan.cx0 + (p.x - pan.x0);
    st.tCy = pan.cy0 + (p.y - pan.y0);
    clampTargetCenter();
  }
});
const release = () => { st.holding = 0; pan.active = false; };
el.pad.addEventListener('pointerup', release);
el.pad.addEventListener('pointercancel', release);
el.pad.addEventListener('lostpointercapture', release);

// Центр цели держим в допустимых пределах, чтобы рамка сразу реагировала у краёв
function clampTargetCenter() {
  const half = 0.5 / Math.max(1, st.tZoom);
  st.tCx = clamp(st.tCx, half, 1 - half);
  st.tCy = clamp(st.tCy, half, 1 - half);
}

function resetZoom() { st.holding = 0; pan.active = false; st.tZoom = 1; st.tCx = 0.5; st.tCy = 0.5; }
el.pad.addEventListener('dblclick', resetZoom);
el.pad.addEventListener('contextmenu', (e) => e.preventDefault());

el.pad.addEventListener('wheel', (e) => {
  e.preventDefault();
  const zoomIn = e.deltaY < 0;
  st.tZoom = clamp(st.tZoom * Math.exp(-e.deltaY * 0.0015), 1, cfg.maxZoom);
  if (zoomIn) { const p = norm(e); st.tCx = p.x; st.tCy = p.y; }
}, { passive: false });

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ---------- анимация ----------
let lastT = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  if (st.holding === 1) {        // ЛКМ: приближаем к курсору
    st.tZoom = Math.min(cfg.maxZoom, st.tZoom * Math.exp(cfg.speed * dt));
    st.tCx = st.px; st.tCy = st.py;
  } else if (st.holding === -1) { // ПКМ: отдаляем, тоже следуя за курсором
    st.tZoom = Math.max(1, st.tZoom * Math.exp(-cfg.speed * dt));
    st.tCx = st.px; st.tCy = st.py;
  }
  st.tZoom = clamp(st.tZoom, 1, cfg.maxZoom);
  clampTargetCenter();

  const k = 1 - Math.exp(-cfg.smooth * dt);
  st.zoom += (st.tZoom - st.zoom) * k;
  st.cx += (st.tCx - st.cx) * k;
  st.cy += (st.tCy - st.cy) * k;

  // Видимая область в нормализованных координатах
  const w = 1 / st.zoom, h = 1 / st.zoom;
  const left = clamp(st.cx - w / 2, 0, 1 - w);
  const top = clamp(st.cy - h / 2, 0, 1 - h);

  el.rect.style.left = (left * 100) + '%';
  el.rect.style.top = (top * 100) + '%';
  el.rect.style.width = (w * 100) + '%';
  el.rect.style.height = (h * 100) + '%';
  el.handle.hidden = st.tZoom < 1.01 && !pan.active; // на общем плане двигать нечего

  if (!connected || !target || st.inflight) return;

  const { srcW, srcH } = target;
  const cl = Math.max(0, Math.round(left * srcW));
  const ct = Math.max(0, Math.round(top * srcH));
  const cr = Math.max(0, Math.round(srcW - (left + w) * srcW));
  const cb = Math.max(0, Math.round(srcH - (top + h) * srcH));
  const key = `${cl},${cr},${ct},${cb}`;
  if (key === st.lastSent) return;

  // Один batch-запрос на все элементы источника во всех сценах
  const crop = { cropLeft: cl, cropRight: cr, cropTop: ct, cropBottom: cb };
  const requests = target.items.map(({ sceneName, sceneItemId }) => ({
    requestType: 'SetSceneItemTransform',
    requestData: { sceneName, sceneItemId, sceneItemTransform: crop },
  }));
  st.inflight = true;
  st.lastSent = key;
  obs.callBatch(requests)
    .then((results) => {
      if (results.some((r) => !r.requestStatus.result)) scheduleRescan(); // какой-то элемент пропал
    })
    .catch((e) => info('Ошибка: ' + (e.message || e)))
    .finally(() => { st.inflight = false; });
}, 1000 / 60);

// ---------- UI ----------
// Кнопка живёт в <summary>: гасим клик, чтобы панель не сворачивалась/разворачивалась
el.connect.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); connect(); });
el.scene.addEventListener('change', () => loadItems().catch((e) => info(e.message)));
el.item.addEventListener('change', () => selectItem().catch((e) => info(e.message)));
el.refresh.addEventListener('click', () => connected && loadScenes().catch((e) => info(e.message)));
el.restore.addEventListener('click', restoreOriginal);
for (const name of ['speed', 'maxZoom', 'smooth']) {
  el[name].addEventListener('input', () => { cfg[name] = Number(el[name].value); saveCfg(); });
}

previewLoop();
if (cfg.autoConnect) connect();

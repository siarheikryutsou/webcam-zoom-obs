# Webcam Zoom: техническая документация

Проект: `H:\Work\webcam-zoom-obs\`. Это HTML-панель, которая встраивается в OBS как док и через **obs-websocket** управляет элементом сцены с веб-камерой. Здесь описано, как устроено подключение к OBS и работа с камерой. Цель: чтобы другую фичу можно было сделать на той же основе и потом объединить проекты.

> Статус: код написан, синтаксис проверен (`node --check`), в живом OBS ещё не тестировался.

## 1. Общая схема

```
┌───────────── OBS ─────────────────────────────────────────┐
│  Video Capture Device (камера) ── элемент сцены            │
│          ▲ crop / bounds                ▲ screenshot       │
│          │                              │                  │
│  obs-websocket server (ws://127.0.0.1:4455, v5 protocol)   │
│          ▲                                                 │
│  Custom Browser Dock  ← наша HTML-панель (index.html)      │
└───────────────────────────────────────────────────────────┘
```

- Панель сама **не открывает камеру**: на Windows камера обычно эксклюзивна, и её держит OBS. С камерой панель работает только через OBS: читает кадры (скриншоты) и меняет transform элемента сцены.
- **Почему док, а не Browser Source.** Превью OBS не передаёт мышь в источники. Browser Source принимает мышь только через отдельное окно «Взаимодействовать». А Custom Browser Dock — это обычная интерактивная веб-страница внутри интерфейса OBS (CEF).

## 2. Файлы

| Файл | Что внутри |
|---|---|
| `index.html` | Разметка: подключение, выбор сцены и элемента, ползунки, область превью `#pad` |
| `app.js` | Вся логика: подключение, списки, превью, мышь, анимация зума |
| `style.css` | Тёмная тема под OBS |
| `vendor/obs-ws.global.min.js` | `obs-websocket-js` **5.0.6**, браузерная сборка (из `npm/obs-websocket-js@5.0.6/dist/obs-ws.global.min.js`), даёт глобальный класс `OBSWebSocket` |
| `README.md` | Установка для пользователя |

Сборки нет: обычные `<script>`, страница открывается как `file:///...`.

## 3. Настройка OBS (один раз)

1. OBS 28+ (obs-websocket уже встроен). **Инструменты → Настройки сервера WebSocket** → включить. Порт по умолчанию `4455`, пароль задаётся там же.
2. **Доки → Пользовательские браузерные доки** → URL `file:///H:/Work/webcam-zoom-obs/index.html`.

## 4. Подключение (переиспользуемое ядро)

```html
<script src="vendor/obs-ws.global.min.js"></script>
```

```js
const obs = new OBSWebSocket();
await obs.connect('ws://127.0.0.1:4455', password || undefined); // хендшейк Hello/Identify и auth делает библиотека
obs.on('ConnectionClosed', () => { /* статус offline */ });

const res = await obs.call('RequestName', { ...params }); // запрос → Promise с responseData
```

- Авторизацию (SHA256 challenge) библиотека делает сама через crypto-js, поэтому secure context не нужен и `file://` работает.
- Адрес и пароль хранятся в `localStorage` (`webcamZoom.cfg`), есть автоподключение.

## 5. Запросы obs-websocket v5, которые используются

| Запрос | Зачем |
|---|---|
| `GetSceneList` | Список сцен и `currentProgramSceneName`. Сцены приходят **в обратном порядке** относительно UI OBS |
| `GetSceneItemList {sceneName}` | Элементы сцены: `sceneItemId`, `sourceName`, `inputKind`. Камеру ищем по `inputKind`: `dshow_input` (Windows), `av_capture_input`/`macos_avcapture` (macOS), `v4l2_input` (Linux) |
| `GetSceneItemTransform {sceneName, sceneItemId}` | `sourceWidth/Height` (родное разрешение камеры), `width/height` (размер на сцене), `crop*`, `bounds*` |
| `SetSceneItemTransform {sceneName, sceneItemId, sceneItemTransform}` | Меняет crop и bounds. Можно передавать только изменённые поля |
| `GetGroupSceneItemList {sceneName: <имя группы>}` | Элементы внутри группы (`GetSceneItemList` их не показывает) |
| `obs.callBatch([{requestType, requestData}, …])` | Пачка запросов за один round-trip; у каждого результата `requestStatus.result` |
| `GetSourceScreenshot {sourceName, imageFormat:'jpg', imageWidth:480, imageCompressionQuality:70}` | Кадр **источника** (без crop и трансформаций сцены) в виде data URI, сразу идёт в `<img src>` |

## 6. Как работает зум

1. При захвате элемента его исходные `crop*` и `bounds*` сохраняются в `localStorage` (`webcamZoom.orig:<scene>:<id>`), чтобы кнопка «Вернуть исходный вид» могла их восстановить.
2. Элементу ставится `boundsType: 'OBS_BOUNDS_STRETCH'`, `boundsWidth/Height` = текущий размер на сцене (высота подгоняется под пропорции исходника), `boundsAlignment: 0`, crop обнуляется.
3. Зум = crop. Видимая область = `srcW/zoom × srcH/zoom` вокруг центра `(cx, cy)` (нормализованные 0..1), центр ограничен краями кадра. Bounds растягивают обрезанную часть на прежний прямоугольник, так что на сцене это выглядит как приближение.
4. Анимация: `setInterval` на 60 Гц (`requestAnimationFrame` в доке может тормозиться). Целевые значения сглаживаются экспоненциально: `k = 1 - exp(-smooth*dt)`. Пока ЛКМ зажата, `tZoom *= exp(speed*dt)`.
5. Отправка: crop округляется до целых пикселей и отправляется, только если изменился. Одновременно в полёте **не больше одного** запроса (флаг `inflight`), иначе на медленном соединении копится очередь.
6. **Синхронизация по сценам.** crop и bounds задаются у *элемента сцены*, а не у источника. Поэтому одна и та же вебка в разных сценах — это разные элементы со своим transform. Панель берёт `sourceName` выбранного элемента и в `findSourceItems()` проходит `GetSceneList` → `GetSceneItemList` по каждой сцене (для групп `isGroup` ещё `GetGroupSceneItemList`). Каждый найденный элемент готовится через `prepareItem()`: сохраняется исходный вид, ставятся bounds. Crop рассылается всем элементам одним `obs.callBatch([...SetSceneItemTransform])`. Если какой-то запрос в batch упал, или пришли события `SceneItemCreated/Removed`, `SceneCreated/Removed`, `SceneNameChanged`, `InputNameChanged`, список элементов пересканируется с задержкой 300 мс.

## 7. Подводные камни (проверено или известно)

- **Камеру из HTML (`getUserMedia`) не открывать**, пока она занята в OBS: на Windows будет ошибка или чёрный кадр. Если камера нужна в браузере, есть два варианта: кадры через `GetSourceScreenshot` (до ~15 fps, для превью хватает) или OBS Virtual Camera.
- `GetSourceScreenshot` с именем **источника** отдаёт чистый кадр, с именем **сцены** — итоговую картинку сцены.
- Если `sourceWidth/Height = 0`, камера неактивна или источник скрыт.
- `SetSceneItemTransform` не принимает `boundsWidth/Height < 1`. При восстановлении с `OBS_BOUNDS_NONE` эти поля не передаются.
- Crop только целочисленный, поэтому при очень медленном зуме возможна мелкая дрожь. Запасной вариант: масштаб и позиция элемента внутри вложенной сцены (там float).
- Если панель меняет transform, а пользователь в это же время двигает элемент мышью в OBS, они будут перебивать друг друга.

## 8. Что выносить в общий модуль при объединении

- **Подключение**: создание `OBSWebSocket`, connect/disconnect, статус, автоподключение, хранение адреса и пароля.
- **Выбор цели**: списки сцен и элементов, автопоиск камеры по `inputKind`.
- **Превью-цикл**: `GetSourceScreenshot` → `<img>`.
- **Отправка transform с троттлингом**: «одна в полёте + только при изменении».
- **Сохранение и восстановление исходного transform**.

Специфика фичи (здесь — мышь и зум) живёт отдельно поверх этого ядра.
